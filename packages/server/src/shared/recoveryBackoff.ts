/**
 * The waiting rules the hub's watchdogs share (`AgentRecoveryWatchdog` for a Windows agent and the misao on it,
 * `LocalMisaoWatchdog` for the hub's own misao): a failure is first waited out for `baseMs`, then an attempt is made, then the waits
 * double up to `maxMs`.
 */
export interface RecoveryTiming {
  /** How often the thing watched is looked at. */
  tickMs: number;
  /** How long a failure has to last before the first attempt, and the first wait after it. */
  baseMs: number;
  /** The longest wait between two attempts. */
  maxMs: number;
}

export const DEFAULT_RECOVERY_TIMING: RecoveryTiming = { tickMs: 15_000, baseMs: 60_000, maxMs: 15 * 60_000 };

/** The waiting state of one thing being brought back. */
export interface Backoff {
  /** When the next attempt may be made. */
  nextAt: number;
  /** The wait that follows the next attempt. */
  waitMs: number;
  attempts: number;
  /** What the waits were for (address, credentials, folder, OS...): a thing that was edited starts over. */
  identity: string;
}

/** The state of a failure just seen: the first attempt comes after `baseMs`. */
export function firstBackoff(now: number, identity: string, timing: RecoveryTiming): Backoff {
  return { nextAt: now + timing.baseMs, waitMs: timing.baseMs, attempts: 0, identity };
}

/** The state after an attempt (successful or not): the next one is `waitMs` away, and the wait after that is doubled up to `maxMs`. */
export function afterAttempt(wait: Backoff, now: number, timing: RecoveryTiming): Backoff {
  return { ...wait, nextAt: now + wait.waitMs, waitMs: Math.min(wait.waitMs * 2, timing.maxMs), attempts: wait.attempts + 1 };
}

/** What a revive answers when nothing was done and waiting will not change it: warned once per answer, not on every attempt. */
export const NOTHING_TO_DO_WARNED: ReadonlySet<string> = new Set(['no_task', 'not_installed', 'other_task']);
/** Nothing to say: the daemon answers again, someone chose this (a custom pipe, a task disabled by hand). */
export const QUIET_OUTCOMES: ReadonlySet<string> = new Set(['running', 'custom_socket', 'disabled']);
