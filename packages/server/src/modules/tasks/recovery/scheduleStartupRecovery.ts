import type { MuxDriverAvailability } from '../../tmux/MuxDriverRegistry';

/** What startup recovery needs from the misao connection. */
export interface MisaoConnectionEvents {
  availability(): MuxDriverAvailability;
  onConnected(listener: () => void): () => void;
}

/**
 * Runs startup recovery without waiting for the misao daemon: tmux tasks are recovered at once, while a misao
 * task is skipped (`daemon_unreachable`) until the daemon connects. When it is not yet connected, recovery
 * runs once more on the first connection, however late that is, so misao tasks are still recovered.
 */
export function scheduleStartupRecovery(
  recover: () => Promise<void>,
  misaoConnection: MisaoConnectionEvents | undefined,
): Promise<void> {
  const first = recover();
  if (!misaoConnection || misaoConnection.availability().available) return first;
  const off = misaoConnection.onConnected(() => {
    off();
    void first.then(recover);
  });
  return first;
}
