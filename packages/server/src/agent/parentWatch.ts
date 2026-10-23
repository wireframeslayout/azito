import { execFile } from 'child_process';
import * as path from 'path';

/**
 * Follows a parent process: `onGone` is called once when it is not there any more.
 *
 * Two checks, because a process id can be handed to another process once the first one has ended:
 * - every `aliveIntervalMs`, `isAlive(pid)` (a signal-0 probe: cheap). Only a pid nobody holds any more fails it.
 * - every `verifyIntervalMs`, the parent's creation time is read again and compared with the one remembered at the start. A different
 *   one means the pid now belongs to another process, so the parent is gone. Reading it starts a program, so it is done rarely;
 *   until it runs, a reused pid keeps the agent alive for at most `verifyIntervalMs` more. An unreadable time is "not known", never "gone".
 * When the creation time cannot be read at the start there is nothing to compare: only the first check runs.
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
}

export interface ParentWatch {
  stop(): void;
}

export async function startParentWatch(options: ParentWatchOptions): Promise<ParentWatch> {
  const { pid } = options;
  const original = await options.readCreation(pid);
  if (original === null) options.onUnverifiable?.(`the creation time of the parent process ${pid} cannot be read: only its existence is watched`);

  let gone = false;
  const finish = (reason: string): void => {
    if (gone) return;
    gone = true;
    clearInterval(aliveTimer);
    clearInterval(verifyTimer);
    options.onGone(reason);
  };
  const aliveTimer = setInterval(() => {
    if (!options.isAlive(pid)) finish(`parent process ${pid} is gone`);
  }, options.aliveIntervalMs);
  let verifying = false;
  const verifyTimer = setInterval(() => {
    if (original === null || verifying || gone) return;
    verifying = true;
    options.readCreation(pid).then((current) => {
      if (current !== null && current !== original) finish(`process id ${pid} now belongs to another process (the parent is gone)`);
    }).finally(() => { verifying = false; });
  }, options.verifyIntervalMs);
  aliveTimer.unref();
  verifyTimer.unref();
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
