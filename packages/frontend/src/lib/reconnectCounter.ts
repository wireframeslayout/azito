export interface ReconnectCounterOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  stableMs: number;
}

export type ReconnectDecision =
  | { action: 'reconnect'; attempt: number; delayMs: number }
  | { action: 'give_up' };

export interface ReconnectCounter {
  onOpen(now: number): void;
  onClose(now: number): ReconnectDecision;
  isFirstAttempt(): boolean;
}

export function createReconnectCounter(opts: ReconnectCounterOptions): ReconnectCounter {
  let attempts = 0;
  let openedAt: number | null = null;

  return {
    onOpen(now: number): void {
      openedAt = now;
    },
    onClose(now: number): ReconnectDecision {
      // openedAt === null: onOpen was never called (connection failed before open); skip the reset.
      if (openedAt !== null && now - openedAt >= opts.stableMs) attempts = 0;
      openedAt = null;
      if (attempts >= opts.maxAttempts) return { action: 'give_up' };
      const delayMs = Math.min(opts.baseDelayMs * Math.pow(2, attempts), opts.maxDelayMs);
      attempts++;
      return { action: 'reconnect', attempt: attempts, delayMs };
    },
    isFirstAttempt(): boolean {
      return attempts === 0;
    },
  };
}
