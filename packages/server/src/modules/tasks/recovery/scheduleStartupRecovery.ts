/** What startup recovery needs from the misao connection. */
export interface MisaoConnectionEvents {
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
  if (!misaoConnection) return recovery.recover();
  // Registered before the first pass starts, whatever the initial state: a connection that drops and comes back
  // during the first pass must still lead to a retry of what it left pending.
  let chain: Promise<void> = Promise.resolve();
  const off = misaoConnection.onConnected(() => {
    chain = chain.then(async () => {
      await recovery.recoverSkipped();
      if (!recovery.hasPending()) off();
    });
  });
  const first = recovery.recover();
  chain = first;
  void first.then(() => { if (!recovery.hasPending()) off(); });
  return first;
}
