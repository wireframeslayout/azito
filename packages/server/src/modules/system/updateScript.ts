import fs from 'fs';
import path from 'path';
import os from 'os';
import { Readable } from 'stream';
import { finished } from 'stream/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { UpdateStateManager, type UpdateState, type UpdateStep } from './UpdateStateManager';
import { computeLocalSha256, assertNoTraversal, readSha256FromSumsFile } from '../servers/agent-deploy/integrityVerifier';
import { isServiceManager, restartService, type ServiceManager } from './serviceControl';

const execFileAsync = promisify(execFile);

interface UpdateArgs {
  dataDir: string;
  hubDir: string;
  version: string;
  tarballUrl: string;
  sha256sumsUrl: string;
  oldVersion: string;
  serviceManager: ServiceManager;
}

const HEALTH_CHECK_TIMEOUT_MS = 30_000;
const HEALTH_CHECK_INTERVAL_MS = 1_000;
const SMOKE_TEST_TIMEOUT_MS = 10_000;

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
      case '--service-manager': {
        const value = argv[++i];
        if (!isServiceManager(value)) throw new Error(`Unknown --service-manager: ${value}`);
        args.serviceManager = value;
        break;
      }
    }
  }
  const required: (keyof UpdateArgs)[] = ['dataDir', 'hubDir', 'version', 'tarballUrl', 'sha256sumsUrl', 'oldVersion', 'serviceManager'];
  for (const key of required) {
    if (!args[key]) throw new Error(`Missing required --${key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())} argument`);
  }
  return args as UpdateArgs;
}

async function downloadFile(url: string, destPath: string, token?: string): Promise<void> {
  const headers: Record<string, string> = { 'User-Agent': 'azito-hub' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}): ${url}`);
  const writeStream = fs.createWriteStream(destPath);
  await finished(Readable.fromWeb(res.body as import('stream/web').ReadableStream).pipe(writeStream));
}

/**
 * Runs the hub's own self-update out-of-process (see SystemUpdateService.launchUpdateScript,
 * which detaches it — via `systemd-run` on Linux, a detached session on macOS —
 * so it survives the hub's own restart partway through). Every step's outcome is
 * persisted via UpdateStateManager so GET /api/system/update/progress can report
 * on it even across the restart.
 */
export async function runUpdate(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  // Under systemd the transient unit does not inherit the launching process's
  // environment, so the caller (SystemUpdateService) passes this via --setenv
  // rather than an argv flag — see launchUpdateScript for why. Under launchd
  // the detached child inherits the hub's env directly.
  const token = process.env.AZITO_GITHUB_TOKEN;
  const stateManager = new UpdateStateManager(
    path.join(args.dataDir, 'update-state.json'),
    path.join(args.dataDir, 'update.log'),
  );

  const state: UpdateState = {
    status: 'running',
    step: 'download',
    fromVersion: args.oldVersion,
    toVersion: args.version,
    startedAt: new Date().toISOString(),
    steps: [],
  };

  const runStep = async (step: UpdateStep, message: string, fn: () => Promise<void>): Promise<void> => {
    state.step = step;
    state.steps.push({ step, status: 'running', message });
    stateManager.write(state);
    stateManager.appendLog(`[${step}] ${message}`);
    try {
      await fn();
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

  const currentLink = path.join(args.hubDir, 'current');
  const oldTarget = fs.readlinkSync(currentLink);
  const newInstallDir = path.join(args.hubDir, args.version);
  const dirExistedBefore = fs.existsSync(newInstallDir);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-update-'));

  try {
    const tarballPath = path.join(tmpDir, 'azito-hub.tar.gz');
    const sumsPath = path.join(tmpDir, 'SHA256SUMS');

    await runStep('download', `Downloading ${args.version}`, async () => {
      await downloadFile(args.tarballUrl, tarballPath, token);
      await downloadFile(args.sha256sumsUrl, sumsPath, token);
    });

    await runStep('verify', 'Verifying SHA256', async () => {
      const expected = readSha256FromSumsFile(sumsPath, path.basename(new URL(args.tarballUrl).pathname));
      const actual = await computeLocalSha256(tarballPath);
      if (actual !== expected) throw new Error(`SHA256 mismatch: expected ${expected}, got ${actual}`);
    });

    await runStep('extract', `Extracting to ${newInstallDir}`, async () => {
      await assertNoTraversal(tarballPath);
      fs.mkdirSync(newInstallDir, { recursive: true });
      await execFileAsync('tar', ['xzf', tarballPath, '-C', newInstallDir, '--no-same-owner', '--no-same-permissions']);
      if (process.platform === 'darwin') {
        // Mirror what install.sh does: Gatekeeper refuses to exec a quarantined
        // binary, and the bundled `node` is the first thing the smoke test runs.
        // Best-effort — a missing xattr is not an error worth failing on.
        await execFileAsync('xattr', ['-dr', 'com.apple.quarantine', newInstallDir]).catch(() => {});
      }
    });

    await runStep('smoke-test', 'Running smoke test', async () => {
      const bundlePath = path.join(newInstallDir, 'azito-hub.cjs');
      const { stdout } = await execFileAsync(process.execPath, [bundlePath, '--version'], { timeout: SMOKE_TEST_TIMEOUT_MS });
      if (!stdout.includes(args.version)) throw new Error(`Smoke test version mismatch: got "${stdout.trim()}"`);
    });

    await runStep('switch', `Switching current -> ${args.version}`, async () => {
      fs.symlinkSync(newInstallDir, `${currentLink}.tmp`);
      fs.renameSync(`${currentLink}.tmp`, currentLink);
    });

    await runStep('restart', 'Restarting azito service', async () => {
      await restartService(args.serviceManager);
    });

    await runStep('health-check', 'Waiting for healthy restart', async () => {
      await waitForHealthyVersion(args.version);
    });

    state.status = 'success';
    state.completedAt = new Date().toISOString();
    stateManager.write(state);
    stateManager.appendLog(`Update succeeded: ${args.oldVersion} -> ${args.version}`);
  } catch (err) {
    const message = (err as Error).message;
    stateManager.appendLog(`Update failed at step "${state.step}": ${message}. Rolling back to ${args.oldVersion}`);
    await rollback(currentLink, oldTarget, args.serviceManager);
    // Only clean up the partially-extracted new version if `current` no
    // longer points at it — rollback() swallows its own errors, and if it
    // failed to re-point the symlink, newInstallDir may still be live.
    if (safeReadlink(currentLink) !== newInstallDir) {
      if (!dirExistedBefore) {
        fs.rmSync(newInstallDir, { recursive: true, force: true });
      } else {
        stateManager.appendLog(`Keeping existing directory: ${newInstallDir}`);
      }
    }
    state.status = 'failed';
    state.error = message;
    state.completedAt = new Date().toISOString();
    stateManager.write(state);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function safeReadlink(linkPath: string): string | null {
  try {
    return fs.readlinkSync(linkPath);
  } catch {
    return null;
  }
}

async function rollback(currentLink: string, oldTarget: string, manager: ServiceManager): Promise<void> {
  try {
    fs.symlinkSync(oldTarget, `${currentLink}.tmp`);
    fs.renameSync(`${currentLink}.tmp`, currentLink);
    await restartService(manager);
  } catch {
    // Best-effort: the state file already records the original failure; a
    // rollback failure here would only obscure it, so it's swallowed rather
    // than propagated (there is no further recovery step to hand it to).
  }
}

async function waitForHealthyVersion(expectedVersion: string): Promise<void> {
  const host = process.env.AZITO_BIND || '127.0.0.1';
  const port = process.env.PORT || '3001';
  const deadline = Date.now() + HEALTH_CHECK_TIMEOUT_MS;
  let lastError = '';

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${host}:${port}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const body = await res.json() as { version: string };
        if (body.version === expectedVersion) return;
        lastError = `Version mismatch: expected ${expectedVersion}, got ${body.version}`;
      } else {
        lastError = `HTTP ${res.status}`;
      }
    } catch (err) {
      lastError = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, HEALTH_CHECK_INTERVAL_MS));
  }

  throw new Error(`Health check timed out: ${lastError}`);
}
