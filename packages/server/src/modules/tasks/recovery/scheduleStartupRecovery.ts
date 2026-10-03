import type { MuxDriverAvailability } from '../../tmux/MuxDriverRegistry';

/** What startup recovery needs from the misao connection. */
export interface MisaoConnectionEvents {
  availability(): MuxDriverAvailability;
  onConnected(listener: () => void): () => void;
}

/**
 * Runs startup recovery without waiting for the misao daemon: tmux tasks are recovered at once, while a misao
 * task is deferred (`daemon_unreachable`) until the daemon connects. When it is not yet connected, only the
 * deferred tasks are recovered on each connection, however late — tasks the first run already resumed are not
 * resumed a second time — until none is left waiting.
 */
export function scheduleStartupRecovery(
  recovery: { recover: () => Promise<void>; recoverSkipped: () => Promise<void>; hasPending: () => boolean },
  misaoConnection: MisaoConnectionEvents | undefined,
): Promise<void> {
  const first = recovery.recover();
  if (!misaoConnection || misaoConnection.availability().available) return first;
  let chain = first;
  const off = misaoConnection.onConnected(() => {
    chain = chain.then(async () => {
      await recovery.recoverSkipped();
      if (!recovery.hasPending()) off();
    });
  });
  void first.then(() => { if (!recovery.hasPending()) off(); });
  return first;
}
