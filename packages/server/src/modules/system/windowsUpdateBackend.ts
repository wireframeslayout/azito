import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { runCommandSpec } from '../../shared/exec/runCommandSpec';
import { directoryContains } from '../../shared/fs/directoryContains';
import { extractZipSafely } from '../../shared/fs/safeArchive';
import { readHubPointer, writeHubPointer } from './hubPointer';
import type { ServiceManager } from './serviceManager';
import type { PruneReport, UpdateBackend } from './updateBackend';
import { waitForHealthyVersion } from './updateHealth';
import { pruneHubVersions, findHubVersionsInUse } from './windowsHubPrune';
import { runOnWindows, type ServiceCommandContext, type WindowsHub } from './windowsHubOperations';

const execFileAsync = promisify(execFile);

/** The first run of a node.exe that was just written is scanned by the antivirus, which takes much longer than a run of one already seen. */
const SMOKE_TEST_TIMEOUT_MS = 30_000;
/** A cold start of a Windows hub (the antivirus scans what it loads, the launcher waits for its conhost) is slower than the Unix one's 30 s. */
const HEALTH_CHECK_TIMEOUT_MS = 90_000;
const POINTER_ATTEMPTS = 5;
const POINTER_RETRY_MS = 200;
const TRANSIENT_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

export interface WindowsUpdateInput {
  /** `<prefix>\hub`. */
  hubDir: string;
  healthUrl: string;
  /** The bsdtar by absolute path (`hostTarOf`). */
  tar: string;
  hub: WindowsHub;
  manager: ServiceManager;
  /** Of THIS process: `update-run` is not a hub process the stop may end. */
  context: ServiceCommandContext;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Windows: a `zip` unpacked into `hub\<tag>` beside the running version, and `hub\current.txt` switched to it. The hub is restarted with the
 * very sequence of `azito service restart` (`runOnWindows`: the task is owned and found, the hub's processes are looked for before and after
 * `/End`, waited for, and only what is left is ended; this process is never one of them), and the launcher the task runs reads the new pointer.
 */
export function createWindowsUpdateBackend(input: WindowsUpdateInput): UpdateBackend {
  const pointer = path.join(input.hubDir, 'current.txt');
  const restart = (): Promise<void> => runOnWindows('restart', input.manager, input.hub, input.context);

  return {
    archiveName: 'azito-hub.zip',
    healthTimeoutMs: HEALTH_CHECK_TIMEOUT_MS,
    currentRef: () => readHubPointer(pointer),

    async extract(archive, installDir) {
      if (!fs.existsSync(installDir)) {
        await extractZipSafely({ archive, destination: installDir, tar: input.tar });
        return;
      }
      // The folder is already there: a version that was extracted by an earlier run that stopped, or the running version being installed
      // again. It is never written into (its node.exe may be running). It is used only if it holds everything the archive holds.
      const staging = path.join(input.hubDir, `.${path.basename(installDir)}.verify-${crypto.randomBytes(4).toString('hex')}`);
      try {
        await extractZipSafely({ archive, destination: staging, tar: input.tar });
        const difference = await directoryContains(staging, installDir);
        if (difference !== null) {
          throw new Error(`${installDir} already exists and is not the downloaded release (${difference}); it is not replaced. Rename or delete that folder and update again`);
        }
      } finally {
        fs.rmSync(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      }
    },

    async smokeTest(installDir, version) {
      // The NEW version's node.exe: it is the one the task will run, and the running version's would not show a broken one.
      const { stdout } = await execFileAsync(path.join(installDir, 'node.exe'), [path.join(installDir, 'azito-hub.cjs'), '--version'], { timeout: SMOKE_TEST_TIMEOUT_MS });
      if (!stdout.includes(version)) throw new Error(`Smoke test version mismatch: got "${stdout.trim()}"`);
    },

    async switchTo(_installDir, version) {
      await writePointerWithRetry(pointer, version);
    },

    restart,

    async rollback(ref, switched) {
      // Before the pointer was switched nothing changed, so the running hub is left alone.
      if (!switched) return;
      await writePointerWithRetry(pointer, ref);
      await restart();
      await waitForHealthyVersion(input.healthUrl, ref, HEALTH_CHECK_TIMEOUT_MS);
    },

    isCurrent(installDir) {
      try {
        return readHubPointer(pointer) === path.basename(installDir);
      } catch {
        // A pointer that cannot be read cannot say this folder is not in use, so it is kept.
        return true;
      }
    },

    pruneOldVersions: (versions): Promise<PruneReport> => pruneHubVersions({
      hubDir: input.hubDir,
      ...versions,
      versionsInUse: () => findHubVersionsInUse((spec) => runCommandSpec(spec, input.hub.runHost), input.hub.systemRoot, input.hub.hubRoots),
    }),

    removeInstallDir: (installDir) => fs.rmSync(installDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }),
  };
}

/** A launcher reading the pointer at that moment makes the replacing rename fail with a sharing violation; it passes in a moment. */
async function writePointerWithRetry(pointer: string, version: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      writeHubPointer(pointer, version);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === undefined || !TRANSIENT_CODES.has(code) || attempt >= POINTER_ATTEMPTS) throw err;
      await sleep(POINTER_RETRY_MS);
    }
  }
}
