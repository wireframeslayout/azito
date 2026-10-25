import type { SecretFileGuard } from '../../../shared/os/secretFileGuard';
import { ProcessLock, ProcessLockBusyError, misaoRootLockEndpoint } from '../../../shared/processLock';
import { MisaoServiceError } from './MisaoServiceError';
import { readOrCreateLockKey } from './misaoLockKey';

/**
 * The one-at-a-time slot of a Windows misao folder, across processes (`shared/processLock.ts`): the hub's Setup row, API and
 * `LocalMisaoWatchdog`, `azito misao install|start|update`, and an install / update / revive the hub runs through a Windows agent whose
 * folder is the same one. The slot is a named pipe named from the folder AND the folder's secret key (`misaoLockKey.ts`), so it is the
 * same for every one of them and cannot be named, hence taken first, by another user. The key is read when the slot is taken, so a key
 * that cannot be read fails that operation with the reason instead of failing the hub's start.
 */
export function createMisaoRootLock(root: string, guard: SecretFileGuard): ProcessLock {
  return new ProcessLock(() => misaoRootLockEndpoint(root, readOrCreateLockKey(root, guard)));
}

/** Runs `operation` holding `lock`; a taken slot is a `busy` refusal that names the holder (nothing waits). */
export async function underMisaoRootLock<T>(lock: ProcessLock, operation: () => Promise<T>): Promise<T> {
  try {
    return await lock.run(operation);
  } catch (err) {
    if (err instanceof ProcessLockBusyError) {
      throw new MisaoServiceError('busy', `Another process${err.ownerPid !== undefined ? ` (${err.ownerPid})` : ''} is running a misao operation on this folder. Try again when it has finished.`);
    }
    throw err;
  }
}
