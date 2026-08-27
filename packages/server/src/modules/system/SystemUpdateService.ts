import path from 'path';
import { execFile, spawn } from 'child_process';
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

const execFileAsync = promisify(execFile);

export type SystemUpdateStatus =
  | 'up-to-date' | 'checking' | 'update-available' | 'check-failed'
  | 'confirming' | 'running' | 'restarting' | 'success' | 'failed'
  | 'disabled' | 'blocked';

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

interface CachedCheck {
  fetchedAt: number;
  channel: 'stable' | 'rc';
  target: UpdateTarget | null;
}

// A task in any of these statuses has an agent actively driving a worktree —
// starting an update (which restarts the hub and drops all tmux/agent
// connections) mid-run would strand it. Terminal statuses (done/failed/
// archived/open) and "review" (task succeeded, awaiting human review — no
// agent running) are excluded.
const NON_TERMINAL_TASK_STATUSES: TaskStatus[] = ['running', 'in_progress', 'phase_review', 'waiting_input'];

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
// as a symlink target — validate the shape before it ever reaches path.join
// so a crafted/unexpected tag_name (e.g. containing "/" or "..") can't escape
// hubDir. Matches the vN.N.N[-suffix] tags produced by the release workflow.
const VERSION_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

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

function currentPlatformArch(): { platform: 'linux' | 'darwin'; arch: 'x64' | 'arm64' } {
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return { platform, arch };
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

    const target = await this.resolveTarget(repo);
    if (!target) {
      return this.buildResponse('check-failed', currentVersion, currentCommit, null, deployMode, runningTasks, disabledReason, repo);
    }

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

    const target = version ? await this.fetchSpecificRelease(repo, version) : await this.resolveTarget(repo);
    const release = getReleaseInfo();
    const currentVersion = release?.version ?? null;
    if (!target) {
      return { started: false, error: '最新バージョンの確認に失敗しました' };
    }
    if (!currentVersion) {
      return { started: false, error: '現在のバージョンを取得できませんでした' };
    }
    if (!version && !isNewer(target.version, currentVersion)) {
      return { started: false, error: '既に最新バージョンです' };
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

  private async resolveTarget(repo: string): Promise<UpdateTarget | null> {
    const channel = this.channelResolver.resolveChannel();
    if (this.cachedCheck && Date.now() - this.cachedCheck.fetchedAt < CHECK_CACHE_TTL_MS && this.cachedCheck.channel === channel) {
      return this.cachedCheck.target;
    }

    const target = channel === 'rc'
      ? await this.fetchLatestPrerelease(repo)
      : await this.fetchLatestRelease(repo);
    this.cachedCheck = { fetchedAt: Date.now(), channel, target };
    return target;
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

  private hasRequiredAssets(release: GithubRelease): boolean {
    if (!Array.isArray(release.assets)) return false;
    const { platform, arch } = currentPlatformArch();
    const tarballName = `azito-hub-${release.tag_name}-${platform}-${arch}.tar.gz`;
    return release.assets.some((a) => a.name === tarballName)
      && release.assets.some((a) => a.name === 'SHA256SUMS');
  }

  private async fetchLatestRelease(repo: string): Promise<UpdateTarget | null> {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: this.buildGithubHeaders() });
      if (!res.ok) return null;
      const release = await res.json() as GithubRelease;

      return this.resolveReleaseAssets(release);
    } catch {
      return null;
    }
  }

  private async fetchLatestPrerelease(repo: string): Promise<UpdateTarget | null> {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, { headers: this.buildGithubHeaders() });
      if (!res.ok) return null;
      const releases = await res.json() as GithubRelease[];
      if (!Array.isArray(releases)) return null;
      const valid = releases
        .filter((r) => !r.draft && typeof r.tag_name === 'string' && VERSION_RE.test(r.tag_name))
        .sort((a, b) => compareVersions(b.tag_name, a.tag_name));
      for (const release of valid) {
        const target = this.resolveReleaseAssets(release);
        if (target) return target;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async fetchSpecificRelease(repo: string, version: string): Promise<UpdateTarget | null> {
    try {
      const tag = version.startsWith('v') ? version : `v${version}`;
      const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { headers: this.buildGithubHeaders() });
      if (!res.ok) return null;
      const release = await res.json() as GithubRelease;
      return this.resolveReleaseAssets(release);
    } catch {
      return null;
    }
  }

  async fetchAvailableVersions(): Promise<VersionEntry[]> {
    if (this.cachedVersions && Date.now() - this.cachedVersions.fetchedAt < CHECK_CACHE_TTL_MS) {
      return this.cachedVersions.versions;
    }
    const repo = this.channelResolver.resolve();
    if (!repo) return [];
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, { headers: this.buildGithubHeaders() });
      if (!res.ok) return [];
      const releases = await res.json() as GithubRelease[];
      if (!Array.isArray(releases)) return [];
      const release = getReleaseInfo();
      const currentVersion = release?.version ?? null;
      const versions: VersionEntry[] = [];
      for (const r of releases) {
        if (r.draft || typeof r.tag_name !== 'string' || !VERSION_RE.test(r.tag_name)) continue;
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

  private resolveReleaseAssets(release: GithubRelease): UpdateTarget | null {
    if (typeof release.tag_name !== 'string' || !VERSION_RE.test(release.tag_name)) {
      return null;
    }
    if (!this.hasRequiredAssets(release)) return null;
    const { platform, arch } = currentPlatformArch();
    const tarballName = `azito-hub-${release.tag_name}-${platform}-${arch}.tar.gz`;
    const tarballAsset = release.assets.find((a) => a.name === tarballName)!;
    const sumsAsset = release.assets.find((a) => a.name === 'SHA256SUMS')!;
    return {
      version: release.tag_name,
      publishedAt: release.published_at,
      commits: parseChangelog(release.body),
      tarballUrl: tarballAsset.browser_download_url,
      sha256sumsUrl: sumsAsset.browser_download_url,
    };
  }

  private async launchUpdateScript(target: UpdateTarget, oldVersion: string): Promise<void> {
    const manager = this.deployModeDetector.serviceManager();
    if (!manager) throw new Error('no service manager to restart through');

    const hubDir = path.join(path.dirname(this.dataPaths.dir), 'hub');
    const bundlePath = path.join(hubDir, 'current', 'azito-hub.cjs');
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
      diagnosticsEnabled: isDiagnosticsEnabled(deployMode, channel),
    };
  }
}
