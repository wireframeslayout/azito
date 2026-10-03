import type { MuxDriverAvailability } from '../../tmux/MuxDriverRegistry';

/** What startup recovery needs from the misao connection. */
export interface MisaoConnectionEvents {
  availability(): MuxDriverAvailability;
  onConnected(listener: () => void): () => void;
}

/**
 * Runs startup recovery without waiting for the misao daemon: tmux tasks are recovered at once, while a misao
 * task is skipped (`daemon_unreachable`) until the daemon connects. When it is not yet connected, only the
 * tasks that first run skipped are recovered on the first connection, however late that is — tasks the first
 * run already resumed are not resumed a second time.
 */
export function scheduleStartupRecovery(
  recover: () => Promise<void>,
  recoverSkipped: () => Promise<void>,
  misaoConnection: MisaoConnectionEvents | undefined,
): Promise<void> {
  const first = recover();
  if (!misaoConnection || misaoConnection.availability().available) return first;
  const off = misaoConnection.onConnected(() => {
    off();
    void first.then(recoverSkipped);
  });
  return first;
}
