import { execFile } from 'child_process';
import * as path from 'path';

/**
 * Follows a parent process: `onGone` is called once when it is not there any more.
 *
 * Two checks, because a process id can be handed to another process once the first one has ended:
 * - every `aliveIntervalMs`, `isAlive(pid)` (a signal-0 probe: cheap). Only a pid nobody holds any more fails it. It starts at
 *   once; it does not wait for the creation time to be read (reading it starts a program and can take a while).
 * - the parent's creation time, read once at the start and again every `verifyIntervalMs`, and compared with the first one
 *   that could be read. A different one means the pid now belongs to another process, so the parent is gone. Until it is
 *   known, a reused pid keeps the agent alive for at most that long. An unreadable time is "not known", never "gone".
 * When reading it fails `UNREADABLE_WARN_AFTER` times in a row, `onUnverifiable` is called once (only the pid is being
 * watched); when a read works again, `onVerifiable` is, and a later streak of failures warns again.
 */
export interface ParentWatchOptions {
  pid: number;
  aliveIntervalMs: number;
  verifyIntervalMs: number;
  isAlive: (pid: number) => boolean;
  /** The creation time of the process as an opaque string, or null when it cannot be read. */
  readCreation: (pid: number) => Promise<string | null>;
  onGone: (reason: string) => void;
  onUnverifiable?: (message: string) => void;
  onVerifiable?: (message: string) => void;
}

export interface ParentWatch {
  stop(): void;
}

const UNREADABLE_WARN_AFTER = 3;

export function startParentWatch(options: ParentWatchOptions): ParentWatch {
  const { pid } = options;
  let original: string | null = null;
  let unreadable = 0;
  let warned = false;
  let gone = false;
  let sampling = false;

  const finish = (reason: string): void => {
    if (gone) return;
    gone = true;
    clearInterval(aliveTimer);
    clearInterval(verifyTimer);
    options.onGone(reason);
  };
  const sample = (): void => {
    if (sampling || gone) return;
    sampling = true;
    options.readCreation(pid).then((current) => {
      if (gone) return;
      if (current === null) {
        unreadable += 1;
        if (unreadable >= UNREADABLE_WARN_AFTER && !warned) {
          warned = true;
          options.onUnverifiable?.(`the creation time of the parent process ${pid} cannot be read: only its existence is watched`);
        }
        return;
      }
      unreadable = 0;
      if (warned) {
        warned = false;
        options.onVerifiable?.(`the creation time of the parent process ${pid} can be read again`);
      }
      if (original === null) original = current;
      else if (current !== original) finish(`process id ${pid} now belongs to another process (the parent is gone)`);
    }).finally(() => { sampling = false; });
  };

  const aliveTimer = setInterval(() => {
    if (!options.isAlive(pid)) finish(`parent process ${pid} is gone`);
  }, options.aliveIntervalMs);
  const verifyTimer = setInterval(sample, options.verifyIntervalMs);
  aliveTimer.unref();
  verifyTimer.unref();
  sample();
  return { stop: () => { gone = true; clearInterval(aliveTimer); clearInterval(verifyTimer); } };
}

/** A signal-0 probe. EPERM = the process exists but is not ours to signal: alive. */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The creation time of a process on Windows, read with the PowerShell that ships with it (no dependency): `ToFileTimeUtc()` of its
 * CIM `CreationDate`. Null when it cannot be read (no such process, PowerShell not runnable, no answer in time).
 */
export function readWindowsProcessCreation(systemRoot: string, pid: number): Promise<string | null> {
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = `(Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${Math.trunc(pid)}').CreationDate.ToFileTimeUtc()`;
  return new Promise((resolve) => {
    execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 20_000, windowsHide: true }, (err, stdout) => {
      const text = err ? '' : stdout.trim();
      resolve(/^\d+$/.test(text) ? text : null);
    });
  });
}
