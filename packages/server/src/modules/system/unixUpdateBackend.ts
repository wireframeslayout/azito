import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { assertNoTraversal } from '../servers/agent-deploy/integrityVerifier';
import type { ServiceManager } from './serviceManager';
import type { UpdateBackend } from './updateBackend';

const execFileAsync = promisify(execFile);

const SMOKE_TEST_TIMEOUT_MS = 10_000;
const HEALTH_CHECK_TIMEOUT_MS = 30_000;
/**
 * Every child the extract step runs has a limit, and is killed (SIGKILL) when it is over: `execFile` settles only after the child has ended,
 * so a failed step never leaves a tar still writing into the folder while the run goes on to roll back.
 */
const EXTRACT_TIMEOUT_MS = 10 * 60_000;
const XATTR_TIMEOUT_MS = 60_000;
const CHILD_KILL_SIGNAL = 'SIGKILL';

function safeReadlink(linkPath: string): string | null {
  try {
    return fs.readlinkSync(linkPath);
  } catch {
    return null;
  }
}

/** Linux (systemd) and macOS (launchd): a `tar.gz`, and the `current` symlink under the hub folder switched to the new version. */
export function createUnixUpdateBackend(hubDir: string, service: ServiceManager, platform: NodeJS.Platform): UpdateBackend {
  const currentLink = path.join(hubDir, 'current');
  const switchLink = async (target: string): Promise<void> => {
    fs.symlinkSync(target, `${currentLink}.tmp`);
    fs.renameSync(`${currentLink}.tmp`, currentLink);
  };
  return {
    archiveName: 'azito-hub.tar.gz',
    healthTimeoutMs: HEALTH_CHECK_TIMEOUT_MS,
    currentRef: () => fs.readlinkSync(currentLink),
    async extract(archive, installDir) {
      await assertNoTraversal(archive);
      fs.mkdirSync(installDir, { recursive: true });
      await execFileAsync('tar', ['xzf', archive, '-C', installDir, '--no-same-owner', '--no-same-permissions'], { timeout: EXTRACT_TIMEOUT_MS, killSignal: CHILD_KILL_SIGNAL });
      if (platform === 'darwin') {
        // Mirror what install.sh does: Gatekeeper refuses to exec a quarantined
        // binary, and the bundled `node` is the first thing the smoke test runs.
        // Best-effort — a missing xattr is not an error worth failing on (running out of time is).
        await execFileAsync('xattr', ['-dr', 'com.apple.quarantine', installDir], { timeout: XATTR_TIMEOUT_MS, killSignal: CHILD_KILL_SIGNAL }).catch((err: { killed?: boolean }) => {
          if (err.killed) throw err; // out of time: the step fails (the child has ended by now)
        });
      }
    },
    async smokeTest(installDir, version) {
      const bundlePath = path.join(installDir, 'azito-hub.cjs');
      const { stdout } = await execFileAsync(process.execPath, [bundlePath, '--version'], { timeout: SMOKE_TEST_TIMEOUT_MS });
      if (!stdout.includes(version)) throw new Error(`Smoke test version mismatch: got "${stdout.trim()}"`);
    },
    switchTo: (installDir) => switchLink(installDir),
    restart: () => service.restart(),
    async rollback(ref) {
      try {
        await switchLink(ref);
        await service.restart();
      } catch {
        // Best-effort: the state file already records the original failure; a
        // rollback failure here would only obscure it, so it's swallowed rather
        // than propagated (there is no further recovery step to hand it to).
      }
    },
    isCurrent: (installDir) => safeReadlink(currentLink) === installDir,
    removeInstallDir: (installDir) => fs.rmSync(installDir, { recursive: true, force: true }),
  };
}
