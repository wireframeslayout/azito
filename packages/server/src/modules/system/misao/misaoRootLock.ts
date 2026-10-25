import path from 'path';
import type { SecretFileGuard } from '../../../shared/os/secretFileGuard';
import { FileLock, ProcessLockBusyError, type ExclusiveLock } from '../../../shared/processLock';
import { MisaoServiceError } from './MisaoServiceError';

/**
 * The one-at-a-time slot of a Windows misao folder, across processes (`shared/processLock.ts`): the hub's Setup row, API and
 * `LocalMisaoWatchdog`, `azito misao install|start|update`, and an install / update / revive the hub runs through a Windows agent whose
 * folder is the same one. The slot is `<root>\.operation.lock`, held open exclusively while the operation runs; the folder must be
 * owner-only (checked at every acquisition), which is what keeps another user from creating or opening the file first.
 */
export function createMisaoRootLock(root: string, guard: SecretFileGuard): ExclusiveLock {
  return new FileLock(path.join(root, '.operation.lock'), path.join(root, '.operation.owner'), guard);
}

/** Runs `operation` holding `lock`; a taken slot is a `busy` refusal that names the holder when it can (nothing waits). */
export async function underMisaoRootLock<T>(lock: ExclusiveLock, operation: () => Promise<T>): Promise<T> {
  try {
    return await lock.run(operation);
  } catch (err) {
    if (err instanceof ProcessLockBusyError) {
      throw new MisaoServiceError('busy', `Another process (${err.owner ? `${err.owner.pid}, started ${err.owner.started}` : 'unknown'}) is running a misao operation on this folder. Try again when it has finished.`);
    }
    throw err;
  }
}
