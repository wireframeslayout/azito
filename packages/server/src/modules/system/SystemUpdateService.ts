import { execFile, spawn } from 'child_process';
import path from 'path';
import { promisify } from 'util';
import type { DataPaths } from '../../shared/dataDir';
import { getReleaseInfo } from '../../shared/releaseInfo';
import type { SqliteTaskRepository } from '../tasks/SqliteTaskRepository';
import type { TaskStatus } from '../tasks/TaskStatus';
import { UpdateChannelResolver } from './UpdateChannelResolver';
import { UpdateStateManager, type UpdateState } from './UpdateStateManager';
import { DeployModeDetector, type DeployMode } from './DeployModeDetector';
import { compareVersions, isNewer } from './semver';
import { isDiagnosticsEnabled } from './diagnosticsEligibility';
import { DuplicateLoadError, type ServiceManager } from './serviceManager';
import { assertSupportedHubHost, hubAssetNames, resolveHubInstallPaths, type HubInstallHost } from './hubInstall';
import { isReleaseTag } from './hubVersion';
import { healthUrlOf } from './updateHealth';
import { launchHubUpdateTask, type HubUpdateLauncher } from './windowsHubUpdateTask';
import { resolveWindowsUserId } from './windowsHubService';

const execFileAsync = promisify(execFile);

export type SystemUpdateStatus =
  | 'up-to-date' | 'checking' | 'update-available' | 'check-failed'
  | 'confirming' | 'running' | 'restarting' | 'success' | 'failed'
  | 'disabled' | 'blocked' | 'no-asset';

export interface UpdateCommit {
  sha: string;
  message: string;
}

export interface UpdateStatusResponse {
  status: SystemUpdateStatus;
  currentVersion: string | null;
  currentCommit: string | null;
  latestVersion: string | null;
  latestCommit: string | null;
  latestDate: string | null;
  commits: UpdateCommit[];
  commitsBehind: number;
  repo: string | null;
  deployMode: DeployMode;
  runningTasks: number;
  disabledReason: string | null;
  channel: 'stable' | 'rc';
  /** `no-asset` のとき、版にあるべきなのに無かったこの OS 向けの配布物の名前（それ以外は null）。 */
  missingAsset: string | null;
  /** 稼働検知診断の導線を UI に出してよいか（{@link isDiagnosticsEnabled}）。 */
  diagnosticsEnabled: boolean;
}

export interface UpdateProgressResponse {
  state: UpdateState | null;
  log: string[];
}

interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GithubRelease {
  tag_name: string;
  body: string | null;
  published_at: string;
  draft: boolean;
  prerelease: boolean;
  assets: GithubReleaseAsset[];
}

export interface VersionEntry {
  version: string;
  publishedAt: string;
  prerelease: boolean;
  relation: 'newer' | 'same' | 'older';
}

interface UpdateTarget {
  version: string;
  publishedAt: string;
  commits: UpdateCommit[];
  tarballUrl: string;
  sha256sumsUrl: string;
}

/**
 * What looking up a release came to. `failed` = the release could not be had (network, API error, malformed answer);
 * `no-asset` = a release was had but lacks this host's archive or checksum file (not a failure of the check).
 */
type TargetResolution =
  | { kind: 'found'; target: UpdateTarget }
  | { kind: 'no-asset'; version: string; missingAsset: string }
  | { kind: 'failed' };

const FAILED: TargetResolution = { kind: 'failed' };

/** The refusal shown when an update names (or resolves to) a version without this host's asset. */
export function noAssetMessage(version: string, asset: string): string {
  return `${version} には、この OS 向けの配布物（${asset}）がありません`;
}

interface CachedCheck {
  fetchedAt: number;
  channel: 'stable' | 'rc';
  resolution: TargetResolution;
}

// A task in any of these statuses has an agent actively driving a worktree —
// starting an update (which restarts the hub and drops all tmux/agent
// connections) mid-run would strand it. Terminal statuses (done/failed/
// archived/open) and "review" (task succeeded, awaiting human review — no
// agent running) are excluded.
const NON_TERMINAL_TASK_STATUSES: TaskStatus[] = ['running', 'in_progress', 'phase_review', 'waiting_input'];

/** Where the release API is. */
export const GITHUB_API_BASE = 'https://api.github.com';

/** A loopback address with an optional port: the only other place the release API may be (see {@link resolveGithubApiBase}). */
const LOOPBACK_API_BASE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/;

/**
 * `AZITO_UPDATE_API_BASE` points the release API at a local server, FOR TESTS ONLY (the Windows CI smoke test serves a fake `releases` API
 * and its assets from the machine itself). Only an `http://` loopback address is accepted; anything else, which would send a release lookup
 * (and the GitHub token) to a host of somebody's choosing, stops the hub from starting with the reason. Unset: GitHub.
 */
export function resolveGithubApiBase(env: NodeJS.ProcessEnv): string {
  const value = env.AZITO_UPDATE_API_BASE;
  if (value === undefined || value === '') return GITHUB_API_BASE;
  if (!LOOPBACK_API_BASE.test(value)) throw new Error(`AZITO_UPDATE_API_BASE must be an http:// loopback address (127.0.0.1, localhost or [::1]) and is for tests only: got "${value}"`);
  return value;
}

/** What only a Windows hub needs to launch its update: the Task Scheduler client and the guard that writes the token file, and the user and `%SystemRoot%` the task is built with. */
export interface WindowsUpdateHost {
  launcher: HubUpdateLauncher;
  systemRoot: string;
  env: NodeJS.ProcessEnv;
}

/** What the environment decides, resolved at the entry point. Omitted (tests): GitHub's API and no Windows launcher. */
export interface SystemUpdateOptions {
  githubApiBase: string;
  windowsUpdate: WindowsUpdateHost | null;
}

const PRODUCTION_OPTIONS: SystemUpdateOptions = { githubApiBase: GITHUB_API_BASE, windowsUpdate: null };

const CHECK_CACHE_TTL_MS = 60 * 60 * 1000;

// A `running` state older than this is assumed to belong to a detached
// update-run process that died without writing a final failed/success state
// (e.g. crashed before UpdateStateManager was even constructed) — otherwise
// a single lost process would permanently block every future update attempt.
const STALE_RUNNING_MS = 15 * 60 * 1000;

const TERMINAL_STATE_TTL_MS = 10 * 60 * 1000;

/** Changelog line: `- <sha> <message>`. sha is REQUIRED to avoid treating prose bullets as commits. */
const CHANGELOG_LINE_RE = /^[-*]\s+([0-9a-f]{7,40})\s+(.+)$/;

// Release tags are used as a filesystem path segment (hubDir/<version>) and
// as a symlink target — validate the shape (isReleaseTag) before it ever reaches
// path.join so a crafted/unexpected tag_name (e.g. containing "/" or "..") can't
// escape hubDir. Matches the vN.N.N[-suffix] tags produced by the release workflow.

function parseChangelog(body: string | null): UpdateCommit[] {
  if (!body) return [];
  const commits: UpdateCommit[] = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    const match = CHANGELOG_LINE_RE.exec(line);
    if (!match) continue;
    commits.push({ sha: match[1], message: match[2].trim() });
  }
  return commits;
}

/**
 * Orchestrates the "check for update" / "start update" / "poll progress" flow
 * exposed at /api/system/update/*. The actual download/verify/extract/switch
 * work happens out-of-process (see updateScript.ts, launched via
 * `systemd-run`) because it restarts the hub itself; this service only
 * decides whether starting one is safe and reports on state written to disk
 * by that detached process.
 */
export class SystemUpdateService {
  private cachedCheck: CachedCheck | null = null;
  private cachedVersions: { fetchedAt: number; versions: VersionEntry[] } | null = null;
  // In-process lock closing the TOCTOU window between reading the on-disk
  // state and writing it: the state file alone isn't enough because two
  // concurrent startUpdate() calls (double-click, two browser tabs) can both
  // read "not running" before either has written — this flag is set
  // synchronously before the first `await`, so the second call always sees it.
  private updateInFlight = false;

  constructor(
    private channelResolver: UpdateChannelResolver,
    private stateManager: UpdateStateManager,
    private deployModeDetector: DeployModeDetector,
    private dataPaths: DataPaths,
    private taskRepo: SqliteTaskRepository,
    /** The hub's own service on this host (null where there is none); asked before an update starts whether launchd has it loaded twice. */
    private hubService: ServiceManager | null,
    /** The OS / architecture and bundle location of this hub, resolved at the entry point: which release asset to take and where the hub folder is. */
    private host: HubInstallHost,
    private options: SystemUpdateOptions = PRODUCTION_OPTIONS,
  ) {}

  async getStatus(): Promise<UpdateStatusResponse> {
    return this.checkForUpdate();
  }

  async checkForUpdate(): Promise<UpdateStatusResponse> {
    const deployMode = this.deployModeDetector.detect();
    const disabledReason = this.deployModeDetector.getDisabledReason();
    const runningTasks = this.countRunningTasks();
    const release = getReleaseInfo();
    const currentVersion = release?.version ?? null;
    const currentCommit = release?.commit ?? null;
    const repo = this.channelResolver.resolve();

    if (!this.deployModeDetector.canUpdate()) {
      return this.buildResponse('disabled', currentVersion, currentCommit, null, deployMode, runningTasks, disabledReason, repo);
    }

    if (!repo) {
      return this.buildResponse('check-failed', currentVersion, currentCommit, null, deployMode, runningTasks, disabledReason, null);
    }

    const resolution = await this.resolveTarget(repo);
    if (resolution.kind === 'failed') {
      return this.buildResponse('check-failed', currentVersion, currentCommit, null, deployMode, runningTasks, disabledReason, repo);
    }
    if (resolution.kind === 'no-asset') {
      return { ...this.buildResponse('no-asset', currentVersion, currentCommit, null, deployMode, runningTasks, disabledReason, repo), latestVersion: resolution.version, missingAsset: resolution.missingAsset };
    }
    const target = resolution.target;

    const status: SystemUpdateStatus = currentVersion && isNewer(target.version, currentVersion) ? 'update-available' : 'up-to-date';
    return this.buildResponse(status, currentVersion, currentCommit, target, deployMode, runningTasks, disabledReason, repo);
  }

  async startUpdate(version?: string): Promise<{ started: boolean; error?: string }> {
    if (this.updateInFlight) {
      return { started: false, error: '更新は既に実行中です' };
    }
    this.updateInFlight = true;
    try {
      return await this.doStartUpdate(version);
    } finally {
      this.updateInFlight = false;
    }
  }

  private async doStartUpdate(version?: string): Promise<{ started: boolean; error?: string }> {
    if (!this.deployModeDetector.canUpdate()) {
      return { started: false, error: this.deployModeDetector.getDisabledReason() ?? '現在の起動方式では更新できません' };
    }

    const runningTasks = this.countRunningTasks();
    if (runningTasks > 0) {
      return { started: false, error: `実行中のタスクが ${runningTasks} 件あります。完了してから更新してください` };
    }

    const existing = this.stateManager.read();
    if (existing?.status === 'running' && !this.isStaleRunningState(existing)) {
      return { started: false, error: '更新は既に実行中です' };
    }

    const repo = this.channelResolver.resolve();
    if (!repo) {
      return { started: false, error: '更新チャンネル（配信元リポジトリ）が設定されていません' };
    }

    const resolution = version ? await this.fetchSpecificRelease(repo, version) : await this.resolveTarget(repo);
    const release = getReleaseInfo();
    const currentVersion = release?.version ?? null;
    if (resolution.kind === 'failed') {
      return { started: false, error: '最新バージョンの確認に失敗しました' };
    }
    if (resolution.kind === 'no-asset') {
      return { started: false, error: noAssetMessage(resolution.version, resolution.missingAsset) };
    }
    const target = resolution.target;
    if (!currentVersion) {
      return { started: false, error: '現在のバージョンを取得できませんでした' };
    }
    if (!version && !isNewer(target.version, currentVersion)) {
      return { started: false, error: '既に最新バージョンです' };
    }

    // A job loaded into both launchd domains would only be found at the restart step, after the new version is already switched in.
    if (this.hubService && this.deployModeDetector.serviceManager()) {
      try {
        await this.hubService.loadedDomain();
      } catch (err) {
        if (err instanceof DuplicateLoadError) return { started: false, error: err.message };
        throw err;
      }
    }

    const initialState: UpdateState = {
      status: 'running',
      step: 'download',
      fromVersion: currentVersion,
      toVersion: target.version,
      startedAt: new Date().toISOString(),
      steps: [],
    };
    this.stateManager.write(initialState);
    this.stateManager.appendLog(`Update started: ${currentVersion} -> ${target.version}`);

    try {
      await this.launchUpdateScript(target, currentVersion);
    } catch (err) {
      const message = (err as Error).message;
      this.stateManager.write({ ...initialState, status: 'failed', error: message, completedAt: new Date().toISOString() });
      this.stateManager.appendLog(`Failed to launch update process: ${message}`);
      return { started: false, error: `更新プロセスの起動に失敗しました: ${message}` };
    }

    return { started: true };
  }

  private isStaleRunningState(state: UpdateState): boolean {
    const startedAt = Date.parse(state.startedAt);
    return Number.isFinite(startedAt) && Date.now() - startedAt > STALE_RUNNING_MS;
  }

  getProgress(): UpdateProgressResponse {
    const state = this.stateManager.read();
    if (state && (state.status === 'success' || state.status === 'failed')) {
      const completedAt = state.completedAt ? Date.parse(state.completedAt) : NaN;
      if (!Number.isFinite(completedAt) || Date.now() - completedAt > TERMINAL_STATE_TTL_MS) {
        this.stateManager.clear();
        return { state: null, log: [] };
      }
    }
    return { state, log: this.stateManager.readLog() };
  }

  private countRunningTasks(): number {
    return NON_TERMINAL_TASK_STATUSES.reduce((sum, status) => sum + this.taskRepo.findByStatus(status).length, 0);
  }

  private async resolveTarget(repo: string): Promise<TargetResolution> {
    assertSupportedHubHost(this.host);
    const channel = this.channelResolver.resolveChannel();
    if (this.cachedCheck && Date.now() - this.cachedCheck.fetchedAt < CHECK_CACHE_TTL_MS && this.cachedCheck.channel === channel) {
      return this.cachedCheck.resolution;
    }

    const resolution = channel === 'rc'
      ? await this.fetchLatestPrerelease(repo)
      : await this.fetchLatestRelease(repo);
    this.cachedCheck = { fetchedAt: Date.now(), channel, resolution };
    return resolution;
  }

  private buildGithubHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': 'azito-hub',
      Accept: 'application/vnd.github+json',
    };
    const token = process.env.AZITO_GITHUB_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  /** The name of the first asset this host needs that the release lacks, or null when it has them all. A release whose asset list is not an array is malformed, not "without assets". */
  private missingAsset(release: GithubRelease): string | null {
    const names = hubAssetNames(release.tag_name, this.host);
    if (!release.assets.some((a) => a.name === names.archive)) return names.archive;
    if (!release.assets.some((a) => a.name === names.sums)) return names.sums;
    return null;
  }

  private hasRequiredAssets(release: GithubRelease): boolean {
    return Array.isArray(release.assets) && this.missingAsset(release) === null;
  }

  private async fetchLatestRelease(repo: string): Promise<TargetResolution> {
    try {
      const res = await fetch(`${this.options.githubApiBase}/repos/${repo}/releases/latest`, { headers: this.buildGithubHeaders() });
      if (!res.ok) return FAILED;
      const release = await res.json() as GithubRelease;

      return this.resolveReleaseAssets(release);
    } catch {
      return FAILED;
    }
  }

  private async fetchLatestPrerelease(repo: string): Promise<TargetResolution> {
    try {
      const res = await fetch(`${this.options.githubApiBase}/repos/${repo}/releases?per_page=30`, { headers: this.buildGithubHeaders() });
      if (!res.ok) return FAILED;
      const releases = await res.json() as GithubRelease[];
      if (!Array.isArray(releases)) return FAILED;
      const valid = releases
        .filter((r) => !r.draft && typeof r.tag_name === 'string' && isReleaseTag(r.tag_name))
        .sort((a, b) => compareVersions(b.tag_name, a.tag_name));
      // A newer release still being built may lack the archive: the newest one that has it is taken, as before.
      for (const release of valid) {
        const resolution = this.resolveReleaseAssets(release);
        if (resolution.kind === 'found') return resolution;
      }
      // None has it. A release was had, so say what is missing from the newest rather than calling it a failed check.
      return valid.length > 0 ? this.resolveReleaseAssets(valid[0]) : FAILED;
    } catch {
      return FAILED;
    }
  }

  private async fetchSpecificRelease(repo: string, version: string): Promise<TargetResolution> {
    assertSupportedHubHost(this.host);
    try {
      const tag = version.startsWith('v') ? version : `v${version}`;
      const res = await fetch(`${this.options.githubApiBase}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { headers: this.buildGithubHeaders() });
      if (!res.ok) return FAILED;
      const release = await res.json() as GithubRelease;
      return this.resolveReleaseAssets(release);
    } catch {
      return FAILED;
    }
  }

  async fetchAvailableVersions(): Promise<VersionEntry[]> {
    if (!this.deployModeDetector.canUpdate()) return [];
    if (this.cachedVersions && Date.now() - this.cachedVersions.fetchedAt < CHECK_CACHE_TTL_MS) {
      return this.cachedVersions.versions;
    }
    const repo = this.channelResolver.resolve();
    if (!repo) return [];
    try {
      const res = await fetch(`${this.options.githubApiBase}/repos/${repo}/releases?per_page=30`, { headers: this.buildGithubHeaders() });
      if (!res.ok) return [];
      const releases = await res.json() as GithubRelease[];
      if (!Array.isArray(releases)) return [];
      const release = getReleaseInfo();
      const currentVersion = release?.version ?? null;
      const versions: VersionEntry[] = [];
      for (const r of releases) {
        if (r.draft || typeof r.tag_name !== 'string' || !isReleaseTag(r.tag_name)) continue;
        if (!this.hasRequiredAssets(r)) continue;
        let relation: VersionEntry['relation'] = 'newer';
        if (currentVersion) {
          const cmp = compareVersions(r.tag_name, currentVersion);
          relation = cmp > 0 ? 'newer' : cmp === 0 ? 'same' : 'older';
        }
        versions.push({ version: r.tag_name, publishedAt: r.published_at, prerelease: r.prerelease, relation });
      }
      versions.sort((a, b) => compareVersions(b.version, a.version));
      this.cachedVersions = { fetchedAt: Date.now(), versions };
      return versions;
    } catch {
      return [];
    }
  }

  clearCache(): void {
    this.cachedCheck = null;
    this.cachedVersions = null;
  }

  private resolveReleaseAssets(release: GithubRelease): TargetResolution {
    if (typeof release.tag_name !== 'string' || !isReleaseTag(release.tag_name) || !Array.isArray(release.assets)) {
      return FAILED;
    }
    const missingAsset = this.missingAsset(release);
    if (missingAsset !== null) return { kind: 'no-asset', version: release.tag_name, missingAsset };
    const names = hubAssetNames(release.tag_name, this.host);
    const tarballAsset = release.assets.find((a) => a.name === names.archive)!;
    const sumsAsset = release.assets.find((a) => a.name === names.sums)!;
    return {
      kind: 'found',
      target: {
        version: release.tag_name,
        publishedAt: release.published_at,
        commits: parseChangelog(release.body),
        tarballUrl: tarballAsset.browser_download_url,
        sha256sumsUrl: sumsAsset.browser_download_url,
      },
    };
  }

  private async launchUpdateScript(target: UpdateTarget, oldVersion: string): Promise<void> {
    if (this.deployModeDetector.detect() === 'taskscheduler') {
      await this.launchWindowsUpdate(target, oldVersion);
      return;
    }
    const manager = this.deployModeDetector.serviceManager();
    if (!manager) throw new Error('no service manager to restart through');

    const { hubDir, bundlePath } = resolveHubInstallPaths(this.host);
    const token = process.env.AZITO_GITHUB_TOKEN;

    const scriptArgs = [
      'update-run',
      '--data-dir', this.dataPaths.dir,
      '--hub-dir', hubDir,
      '--version', target.version,
      '--tarball-url', target.tarballUrl,
      '--sha256sums-url', target.sha256sumsUrl,
      '--old-version', oldVersion,
      '--service-manager', manager,
    ];

    if (manager === 'launchd') {
      // launchd has no systemd-run equivalent, so detach directly. `detached`
      // puts the child in its own session, which is what lets it outlive the
      // SIGTERM that `launchctl kickstart -k` sends to this process partway
      // through the update. Env is inherited, so the token/bind/port the
      // script needs are already there.
      const child = spawn(process.execPath, [bundlePath, ...scriptArgs], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return;
    }

    // systemd-run starts a fresh transient unit that does not inherit this
    // process's environment, so the download token — if the private repo
    // needs one — must be passed via --setenv rather than as a plain argv
    // entry (argv is world-readable via /proc/<pid>/cmdline for the life of
    // the process; --setenv only exposes it inside the child's own env).
    const systemdArgs = ['--user', '--collect', '--unit=azito-update'];
    if (token) systemdArgs.push(`--setenv=AZITO_GITHUB_TOKEN=${token}`);
    const bind = process.env.AZITO_BIND;
    if (bind) systemdArgs.push(`--setenv=AZITO_BIND=${bind}`);
    const port = process.env.PORT;
    if (port) systemdArgs.push(`--setenv=PORT=${port}`);
    systemdArgs.push('--', process.execPath, bundlePath, ...scriptArgs);

    await execFileAsync('systemd-run', systemdArgs);
  }

  /**
   * Windows: the update is its own one-shot task (`AzitoHubUpdate`, see windowsHubUpdateTask.ts), because a process this hub spawns would end
   * with the hub's task when the update stops it. It runs the CURRENT version's node.exe and bundle (the new one is not extracted yet), gets
   * the bind address and port as the health URL (a task has no environment), and the token in an owner-only file.
   */
  private async launchWindowsUpdate(target: UpdateTarget, oldVersion: string): Promise<void> {
    const windows = this.options.windowsUpdate;
    if (!windows) throw new Error('this hub was started without the means to launch a Windows update');
    const { hubDir, bundlePath } = resolveHubInstallPaths(this.host);
    const tokenFile = path.join(this.dataPaths.dir, 'update-token');
    const token = process.env.AZITO_GITHUB_TOKEN || undefined;
    const updateArgs = [
      '--data-dir', this.dataPaths.dir,
      '--hub-dir', hubDir,
      '--version', target.version,
      '--tarball-url', target.tarballUrl,
      '--sha256sums-url', target.sha256sumsUrl,
      '--old-version', oldVersion,
      '--service-manager', 'taskscheduler',
      '--health-url', healthUrlOf(process.env.AZITO_BIND || '127.0.0.1', process.env.PORT || '3001'),
      ...(token !== undefined ? ['--token-file', tokenFile] : []),
    ];
    await launchHubUpdateTask(windows.launcher, {
      task: {
        userId: resolveWindowsUserId(windows.env),
        systemRoot: windows.systemRoot,
        hubDir,
        nodePath: process.execPath,
        bundlePath,
        updateArgs,
        outputLog: path.join(this.dataPaths.dir, 'update-run.out.log'),
      },
      tokenFile,
      token,
    });
  }

  private buildResponse(
    status: SystemUpdateStatus,
    currentVersion: string | null,
    currentCommit: string | null,
    target: UpdateTarget | null,
    deployMode: DeployMode,
    runningTasks: number,
    disabledReason: string | null,
    repo: string | null,
  ): UpdateStatusResponse {
    const channel = this.channelResolver.resolveChannel();
    return {
      status,
      currentVersion,
      currentCommit,
      latestVersion: target?.version ?? null,
      latestCommit: target?.commits[0]?.sha || null,
      latestDate: target?.publishedAt ?? null,
      commits: target?.commits ?? [],
      commitsBehind: target?.commits.length ?? 0,
      repo,
      deployMode,
      runningTasks,
      disabledReason,
      channel,
      missingAsset: null,
      diagnosticsEnabled: isDiagnosticsEnabled(deployMode, channel),
    };
  }
}
