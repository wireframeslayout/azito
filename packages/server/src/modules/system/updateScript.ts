import fs from 'fs';
import path from 'path';
import os from 'os';
import { Readable } from 'stream';
import { finished } from 'stream/promises';
import type { SecretFileGuard } from '../../shared/os/secretFileGuard';
import type { HostEnv } from '../../shared/os/hostEnv';
import { hostTarOf } from '../../shared/os/hostTar';
import { runCommandSpec, runHostOf } from '../../shared/exec/runCommandSpec';
import { SchtasksClient, rawRunnerOf } from '../../shared/os/taskScheduler/schtasks';
import { getBundleRoot } from '../../shared/releaseInfo';
import { UpdateStateManager, type UpdateState, type UpdateStep } from './UpdateStateManager';
import { computeLocalSha256, readSha256FromSumsFile } from '../servers/agent-deploy/integrityVerifier';
import { HUB_SERVICE, runCommand, serviceManagerOfKind, type AnyServiceManagerKind } from './serviceManager';
import { createServiceManager } from './createServiceManager';
import type { UpdateBackend } from './updateBackend';
import { createUnixUpdateBackend } from './unixUpdateBackend';
import { healthUrlOf, waitForHealthyVersion } from './updateHealth';
import { createWindowsUpdateBackend } from './windowsUpdateBackend';
import { HUB_UPDATE_TASK } from './windowsHubUpdateTask';
import { resolveWindowsHub } from './windowsHubOperations';
import { createHubLock, underHubLock } from './hubLock';
import { startHubExitWithParent, takeExitWithPid } from '../../app/hubExitWithParent';

interface UpdateArgs {
  dataDir: string;
  hubDir: string;
  version: string;
  tarballUrl: string;
  sha256sumsUrl: string;
  oldVersion: string;
  serviceManager: AnyServiceManagerKind;
  /** A file holding the GitHub token (Windows: a task cannot carry an environment variable, and a command line is no place for a secret). Read, then deleted. */
  tokenFile?: string;
  /** Where the restarted hub answers. Windows passes the hub's own bind address and port; Unix reads `AZITO_BIND` / `PORT` from its environment. */
  healthUrl?: string;
}

function parseServiceManager(value: string | undefined): AnyServiceManagerKind {
  if (value === 'systemd' || value === 'launchd' || value === 'taskscheduler') return value;
  throw new Error(`Unknown --service-manager: ${value}`);
}

function parseArgs(argv: string[]): UpdateArgs {
  const args: Partial<UpdateArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--data-dir': args.dataDir = argv[++i]; break;
      case '--hub-dir': args.hubDir = argv[++i]; break;
      case '--version': args.version = argv[++i]; break;
      case '--tarball-url': args.tarballUrl = argv[++i]; break;
      case '--sha256sums-url': args.sha256sumsUrl = argv[++i]; break;
      case '--old-version': args.oldVersion = argv[++i]; break;
      case '--token-file': args.tokenFile = argv[++i]; break;
      case '--health-url': args.healthUrl = argv[++i]; break;
      case '--service-manager': args.serviceManager = parseServiceManager(argv[++i]); break;
    }
  }
  const required: (keyof UpdateArgs)[] = ['dataDir', 'hubDir', 'version', 'tarballUrl', 'sha256sumsUrl', 'oldVersion', 'serviceManager'];
  for (const key of required) {
    if (!args[key]) throw new Error(`Missing required --${key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())} argument`);
  }
  return args as UpdateArgs;
}

/** A download that has not finished by then (a server that stopped answering) is a failed step, not a wait with no end. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/**
 * The whole run. The Task Scheduler's own limit for the task is one hour; this is shorter so that a run that hangs ends itself, writes
 * its state and puts the old version back, instead of being cut off without a word.
 */
const RUN_DEADLINE_MS = 50 * 60_000;

async function downloadFile(url: string, destPath: string, token?: string): Promise<void> {
  const headers: Record<string, string> = { 'User-Agent': 'azito-hub' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const signal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const res = await fetch(url, { headers, signal });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}): ${url}`);
  const writeStream = fs.createWriteStream(destPath);
  await finished(Readable.fromWeb(res.body as import('stream/web').ReadableStream).pipe(writeStream));
}

/**
 * The token the caller handed over. Windows: in a file, read and deleted right away (the file does not outlive this read, whatever happens
 * after). Unix: in the environment (systemd `--setenv`, or launchd's inherited one).
 */
function takeToken(tokenFile: string | undefined): string | undefined {
  if (tokenFile === undefined) return process.env.AZITO_GITHUB_TOKEN;
  try {
    return fs.readFileSync(tokenFile, 'utf-8').trim() || undefined;
  } finally {
    fs.rmSync(tokenFile, { force: true });
  }
}

/** The backend of this OS. Windows also needs what `azito service restart` needs: the task, the hub's layout and the bundle's location. */
function createBackend(args: UpdateArgs, host: HostEnv, secretFileGuard: SecretFileGuard, healthUrl: string): UpdateBackend {
  if (args.serviceManager !== 'taskscheduler') {
    return createUnixUpdateBackend(args.hubDir, serviceManagerOfKind(args.serviceManager, HUB_SERVICE, runCommand, host), host.platform);
  }
  const created = createServiceManager(host, HUB_SERVICE, runCommand);
  if ('error' in created) throw created.error;
  const context = { env: process.env, bundleRoot: getBundleRoot(), pid: process.pid, secretFileGuard };
  return createWindowsUpdateBackend({
    hubDir: args.hubDir,
    healthUrl,
    tar: hostTarOf(host),
    hub: resolveWindowsHub(host, context),
    manager: created.manager,
    context,
  });
}

/**
 * Runs the hub's own self-update out-of-process (see SystemUpdateService.launchUpdateScript,
 * which detaches it — via `systemd-run` on Linux, a detached session on macOS, a one-shot
 * Task Scheduler task on Windows — so it survives the hub's own restart partway through).
 * Every step's outcome is persisted via UpdateStateManager so GET /api/system/update/progress can
 * report on it even across the restart.
 */
export async function runUpdate(argv: string[], host: HostEnv, secretFileGuard: SecretFileGuard): Promise<void> {
  const args = parseArgs(argv);
  // Under systemd the transient unit does not inherit the launching process's
  // environment, so the caller (SystemUpdateService) passes this via --setenv
  // rather than an argv flag — see launchUpdateScript for why. Under launchd
  // the detached child inherits the hub's env directly. On Windows it comes in a file.
  const stateManager = new UpdateStateManager(
    path.join(args.dataDir, 'update-state.json'),
    path.join(args.dataDir, 'update.log'),
    secretFileGuard,
  );

  const state: UpdateState = {
    status: 'running',
    step: 'download',
    fromVersion: args.oldVersion,
    toVersion: args.version,
    startedAt: new Date().toISOString(),
    steps: [],
  };

  // The run ends by itself when it takes too long, and (Windows) when its task is ended: the Task Scheduler's /End ends only the
  // conhost.exe the task runs under, so the run follows that process the way the hub does (the task's script names it, `AZITO_HUB_EXIT_WITH_PID`).
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(new Error(`The update did not finish within ${RUN_DEADLINE_MS / 60_000} minutes`)), RUN_DEADLINE_MS);
  const parentPid = takeExitWithPid(process.env);
  const parentWatch = args.serviceManager === 'taskscheduler'
    ? startHubExitWithParent({
      hostEnv: host,
      pid: parentPid,
      onGone: (reason) => abort.abort(new Error(`The update task was ended (${reason})`)),
      warn: (message) => stateManager.appendLog(`parent watch: ${message}`),
      info: (message) => stateManager.appendLog(`parent watch: ${message}`),
    })
    : undefined;

  try {
    const token = takeToken(args.tokenFile);
    const healthUrl = args.healthUrl ?? healthUrlOf(process.env.AZITO_BIND || '127.0.0.1', process.env.PORT || '3001');
    const backend = createBackend(args, host, secretFileGuard, healthUrl);
    if (args.serviceManager !== 'taskscheduler') {
      await runUpdateSteps(args, backend, healthUrl, token, state, stateManager, abort.signal);
      return;
    }
    // One at a time with `azito service ...` on the same install. A taken lock is a failed run with the reason, and nothing was changed.
    const lock = createHubLock(args.hubDir, secretFileGuard, host.systemRoot!);
    await underHubLock(lock, () => runUpdateSteps(args, backend, healthUrl, token, state, stateManager, abort.signal));
  } catch (err) {
    // Everything a step throws is recorded inside runUpdateSteps; what gets here is a run that could not even start.
    const message = (err as Error).message;
    stateManager.appendLog(`Update could not start: ${message}`);
    state.status = 'failed';
    state.error = message;
    state.completedAt = new Date().toISOString();
    stateManager.write(state);
  } finally {
    clearTimeout(deadline);
    parentWatch?.stop();
    if (args.serviceManager === 'taskscheduler') await deleteOwnTask(host, stateManager);
  }
}

/** The one-shot task is over with this run: it is deleted (a task left behind is found, and replaced, by the next update). */
async function deleteOwnTask(host: HostEnv, stateManager: UpdateStateManager): Promise<void> {
  try {
    const client = new SchtasksClient(rawRunnerOf((spec) => runCommandSpec(spec, { ...runHostOf(host), rawOutput: true })), host);
    if ((await client.query(HUB_UPDATE_TASK)).exists) await client.delete(HUB_UPDATE_TASK);
  } catch (err) {
    stateManager.appendLog(`Could not delete the task ${HUB_UPDATE_TASK}: ${(err as Error).message}. The next update replaces it`);
  }
}

export async function runUpdateSteps(
  args: UpdateArgs,
  backend: UpdateBackend,
  healthUrl: string,
  token: string | undefined,
  state: UpdateState,
  stateManager: UpdateStateManager,
  signal: AbortSignal,
): Promise<void> {
  /** Rejects when the run is told to end (the deadline, or the task being ended); a step that is still working is left behind and the run goes on to put the old version back. */
  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  aborted.catch(() => undefined);
  const runStep = async (step: UpdateStep, message: string, fn: () => Promise<void>): Promise<void> => {
    state.step = step;
    state.steps.push({ step, status: 'running', message });
    stateManager.write(state);
    stateManager.appendLog(`[${step}] ${message}`);
    try {
      await Promise.race([fn(), aborted]);
      state.steps[state.steps.length - 1] = { step, status: 'ok', message };
      stateManager.write(state);
    } catch (err) {
      const errMessage = (err as Error).message;
      state.steps[state.steps.length - 1] = { step, status: 'error', message: errMessage };
      stateManager.write(state);
      stateManager.appendLog(`[${step}] ERROR: ${errMessage}`);
      throw err;
    }
  };

  const oldRef = backend.currentRef();
  const newInstallDir = path.join(args.hubDir, args.version);
  const dirExistedBefore = fs.existsSync(newInstallDir);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-update-'));
  let switched = false;

  try {
    const archivePath = path.join(tmpDir, backend.archiveName);
    const sumsPath = path.join(tmpDir, 'SHA256SUMS');

    await runStep('download', `Downloading ${args.version}`, async () => {
      await downloadFile(args.tarballUrl, archivePath, token);
      await downloadFile(args.sha256sumsUrl, sumsPath, token);
    });

    await runStep('verify', 'Verifying SHA256', async () => {
      const expected = readSha256FromSumsFile(sumsPath, path.basename(new URL(args.tarballUrl).pathname));
      const actual = await computeLocalSha256(archivePath);
      if (actual !== expected) throw new Error(`SHA256 mismatch: expected ${expected}, got ${actual}`);
    });

    await runStep('extract', `Extracting to ${newInstallDir}`, () => backend.extract(archivePath, newInstallDir));

    await runStep('smoke-test', 'Running smoke test', () => backend.smokeTest(newInstallDir, args.version));

    // `switched` is set the moment the switch has happened, before anything else can fail (the step's own state write included).
    await runStep('switch', `Switching current -> ${args.version}`, async () => {
      await backend.switchTo(newInstallDir, args.version);
      switched = true;
    });

    await runStep('restart', 'Restarting azito service', () => backend.restart());

    await runStep('health-check', 'Waiting for healthy restart', () => waitForHealthyVersion(healthUrl, args.version, backend.healthTimeoutMs));

    state.status = 'success';
    state.completedAt = new Date().toISOString();
    stateManager.write(state);
    stateManager.appendLog(`Update succeeded: ${args.oldVersion} -> ${args.version}`);
  } catch (err) {
    const message = (err as Error).message;
    stateManager.appendLog(`Update failed at step "${state.step}": ${message}. Rolling back to ${args.oldVersion}`);
    let rollbackFailure: string | undefined;
    try {
      await backend.rollback(oldRef, switched);
    } catch (rollbackErr) {
      rollbackFailure = (rollbackErr as Error).message;
      stateManager.appendLog(`Rollback to ${args.oldVersion} failed: ${rollbackFailure}`);
    }
    // Only clean up the partially-extracted new version if the old one is
    // what runs again — a rollback that failed to switch back may have left
    // the new folder live.
    if (!backend.isCurrent(newInstallDir)) {
      if (!dirExistedBefore) {
        try {
          backend.removeInstallDir(newInstallDir);
        } catch (removeErr) {
          stateManager.appendLog(`Could not remove ${newInstallDir}: ${(removeErr as Error).message}`);
        }
      } else {
        stateManager.appendLog(`Keeping existing directory: ${newInstallDir}`);
      }
    }
    state.status = 'failed';
    state.error = rollbackFailure === undefined ? message : `${message} (going back to ${args.oldVersion} also failed: ${rollbackFailure})`;
    state.completedAt = new Date().toISOString();
    stateManager.write(state);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
