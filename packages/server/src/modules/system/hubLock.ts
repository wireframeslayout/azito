import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import type { SecretFileGuard } from '../../shared/os/secretFileGuard';
import { ProcessLock, ProcessLockBusyError, ProcessLockForeignHolderError } from '../../shared/processLock';
import { readOrCreateLockKey } from './misao/misaoLockKey';
import { createPipeHolderCheck } from './misao/misaoPipeHolder';

/**
 * The one-at-a-time slot of a Windows hub install (`<prefix>\hub`), across processes: `azito service install|start|stop|restart|reload`
 * and the in-app update (`update-run`) take it, so that an update is not restarted underneath by hand, nor the other way round.
 * The mechanism is the misao folder's (`shared/processLock.ts`: a named pipe only one process can listen on, released by the OS when its
 * holder dies), and so are its protections: the pipe's name comes from the folder AND a secret key only this user can read
 * (`<prefix>\hub\.lock-key`), and a held pipe is looked at (who serves it) so that another user's process is refused with its reason
 * instead of being waited on.
 */

/** `\\.\pipe\azito-hub-lock-<hash of the folder (real path, lower-cased) and its key>`. The folder is resolved to its real path first: the update is started from a path the hub was given, the CLI from the one azito.cmd uses, and a junction or an 8.3 name must not make two names. */
export function hubLockEndpoint(hubRoot: string, key: string): string {
  const normalised = path.win32.normalize(hubRoot).replace(/[\\/]+$/, '').toLowerCase();
  return `\\\\.\\pipe\\azito-hub-lock-${createHash('sha256').update(`${normalised}\0${key}`).digest('hex').slice(0, 32)}`;
}

export function createHubLock(hubRoot: string, guard: SecretFileGuard, systemRoot: string): ProcessLock {
  return new ProcessLock(() => hubLockEndpoint(fs.realpathSync.native(hubRoot), readOrCreateLockKey(hubRoot, guard)), createPipeHolderCheck(systemRoot));
}

/** Runs `operation` holding `lock`. A taken slot stops with the reason (nothing waits), and the operation has not started. */
export async function underHubLock<T>(lock: ProcessLock, operation: () => Promise<T>): Promise<T> {
  try {
    return await lock.run(operation);
  } catch (err) {
    if (err instanceof ProcessLockForeignHolderError) {
      throw new Error(`${err.message}. Nothing was changed. Until that process is gone the hub's lock cannot be taken (\`azito service ...\` and the in-app update stop for the same reason).`);
    }
    if (err instanceof ProcessLockBusyError) {
      throw new Error(`Another AZITO hub operation${err.ownerPid !== undefined ? ` (process ${err.ownerPid})` : ''} is running on this install (an update or \`azito service ...\`). Nothing was changed; try again when it has finished.`);
    }
    throw err;
  }
}
