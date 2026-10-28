/**
 * Starting to listen on an address that does not exist yet.
 *
 * The agent listens on a Tailscale IP. Right after a logon or a boot that IP may not be there yet (Tailscale is not connected), and
 * `listen` fails with EADDRNOTAVAIL. Ending at once would leave the agent down until something restarts it (on Windows the task's
 * restart-on-failure does not fire, see #549), so this waits for the address, up to a limit, and then ends with the reason.
 * Any other error (EADDRINUSE, EACCES, ...) is not a matter of waiting and is thrown at once. The same code serves every OS.
 */

export const LISTEN_RETRY_INTERVAL_MS = 5_000;
export const LISTEN_RETRY_MAX_WAIT_MS = 10 * 60_000;
/** While waiting, the reason is logged for the first failure and then at most this often. */
export const LISTEN_RETRY_LOG_EVERY_MS = 60_000;

export interface ListenRetryOptions {
  /** One attempt to listen. May be called again on the same server after it failed. */
  listen: () => Promise<unknown>;
  /** The address being listened on, for the log. */
  bind: string;
  port: number;
  log: { warn(message: string): void };
  /** Abort to stop waiting (a termination signal came). */
  signal: AbortSignal;
  intervalMs?: number;
  maxWaitMs?: number;
  logEveryMs?: number;
  /** Waits `ms`, resolving early when `signal` aborts. Replaced in a test so that no real time passes. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** `listening`: the server listens. `aborted`: the signal aborted while waiting, nothing listens. Any other failure throws. */
export type ListenRetryResult = 'listening' | 'aborted';

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isAddressNotAvailable(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'EADDRNOTAVAIL';
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s` : `${seconds}s`;
}

export async function listenWithRetry(options: ListenRetryOptions): Promise<ListenRetryResult> {
  const { listen, bind, port, log, signal } = options;
  const intervalMs = options.intervalMs ?? LISTEN_RETRY_INTERVAL_MS;
  const maxWaitMs = options.maxWaitMs ?? LISTEN_RETRY_MAX_WAIT_MS;
  const logEveryMs = options.logEveryMs ?? LISTEN_RETRY_LOG_EVERY_MS;
  const sleep = options.sleep ?? abortableSleep;

  let waitedMs = 0;
  let lastLoggedAt = -Infinity;
  for (let attempt = 1; ; attempt++) {
    if (signal.aborted) return 'aborted';
    try {
      await listen();
      return 'listening';
    } catch (err) {
      if (!isAddressNotAvailable(err)) throw err;
      if (waitedMs >= maxWaitMs) {
        throw new Error(
          `${bind}:${port} was still not available after waiting ${formatDuration(waitedMs)} (${attempt} attempts); is Tailscale connected on this host? ${(err as Error).message}`,
        );
      }
      if (waitedMs - lastLoggedAt >= logEveryMs) {
        lastLoggedAt = waitedMs;
        log.warn(
          `Address ${bind} is not available yet (attempt ${attempt}); waiting for Tailscale to connect, retrying every ${formatDuration(intervalMs)}, ${formatDuration(maxWaitMs - waitedMs)} left`,
        );
      }
    }
    await sleep(intervalMs, signal);
    waitedMs += intervalMs;
  }
}
