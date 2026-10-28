/**
 * How the agent is asked to stop, before and after it listens.
 *
 * Every way of being stopped (SIGTERM / SIGINT / SIGHUP, and on Windows the parent `conhost.exe` being gone) goes to `requestStop`.
 * - Before the server listens (it may be waiting for its address): the stop aborts `startupSignal`, and `main` then calls `shutdown`.
 * - After it listens: the stop is `shutdown` at once.
 * `shutdown` closes the server and exits, with a hard cap if closing hangs (e.g. a stuck Chromium); a second request is ignored.
 */

import type { ListenRetryResult } from './listenRetry';

export type StopSignal = 'SIGTERM' | 'SIGINT' | 'SIGHUP';
const STOP_SIGNALS: readonly StopSignal[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];

export interface AgentLifecycleDeps {
  /** `process.on` */
  onSignal: (signal: StopSignal, handler: () => void) => void;
  close: () => Promise<void>;
  exit: (code: number) => void;
  log: { info(message: string): void; warn(message: string): void };
  hardCapMs: number;
  setTimer?: (callback: () => void, ms: number) => { unref(): unknown };
}

export interface AgentLifecycle {
  /** Aborted by a stop requested before {@link finishStartup}. */
  readonly startupSignal: AbortSignal;
  /** Why the startup was stopped (undefined while it was not). */
  readonly startupStopReason: string | undefined;
  requestStop(reason: string): void;
  /**
   * Called with what `listenWithRetry` returned. `aborted`: a stop was asked, so it shuts down (the server may already listen) and
   * returns false. Otherwise the server now listens, later stops shut it down, and it returns true.
   */
  finishStartup(result: ListenRetryResult): boolean;
  shutdown(reason: string): void;
}

export function createAgentLifecycle(deps: AgentLifecycleDeps): AgentLifecycle {
  const startupAbort = new AbortController();
  let listening = false;
  let shuttingDown = false;
  let startupStopReason: string | undefined;
  const setTimer = deps.setTimer ?? ((callback, ms) => setTimeout(callback, ms));

  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.log.info(`Received ${reason}, shutting down gracefully`);
    setTimer(() => {
      deps.log.warn('Graceful shutdown exceeded hard cap, forcing exit');
      deps.exit(0);
    }, deps.hardCapMs).unref();
    deps.close().then(() => deps.exit(0)).catch(() => deps.exit(0));
  };

  const requestStop = (reason: string): void => {
    if (listening) return shutdown(reason);
    startupStopReason ??= reason;
    startupAbort.abort();
  };

  for (const signal of STOP_SIGNALS) deps.onSignal(signal, () => requestStop(signal));

  return {
    startupSignal: startupAbort.signal,
    get startupStopReason() {
      return startupStopReason;
    },
    requestStop,
    finishStartup: (result) => {
      if (result === 'aborted') {
        if (startupStopReason === undefined) throw new Error('startup was aborted without a stop reason');
        shutdown(startupStopReason);
        return false;
      }
      listening = true;
      return true;
    },
    shutdown,
  };
}
