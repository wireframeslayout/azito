/** Quiet period after the last child output before the child counts as "booted". */
const READY_QUIET_MS = 500;
/**
 * Minimum cumulative output before quiet can mean "booted". A claude TUI's
 * welcome screen is several KB of drawing; a boot that pauses >500ms after only
 * a few bytes (observed in E2E: paste lost mid-boot) must NOT count as ready.
 */
const READY_MIN_OUTPUT_BYTES = 2_048;
/**
 * Upper bound for waiting on readiness. Kept below the hub's 10s ack timeout so
 * a stuck boot still produces an ack instead of an ack_timeout.
 */
const READY_WAIT_MAX_MS = 8_000;
/**
 * Fallback quiet period: if any output was produced but cumulative bytes never
 * reached minOutputBytes, this longer silence means "the TUI finished drawing
 * its (slim) boot screen and is now idle".
 */
const READY_FALLBACK_QUIET_MS = 2_500;

export interface ReadinessGateOptions {
  quietMs?: number;
  minOutputBytes?: number;
  maxWaitMs?: number;
  fallbackQuietMs?: number;
}

/**
 * Latches "the child TUI has finished booting": cumulative output has reached
 * minOutputBytes AND quietMs have passed since the last output chunk (boot
 * redraw settled). Injecting a bracketed paste before that point loses the
 * prompt (the TUI's input field does not exist yet), so inject_prompt waits on
 * this gate.
 *
 * Once ready, the gate stays ready forever — later output never re-blocks it.
 * Intentionally independent from ActivityTracker (different question, simpler
 * lifecycle).
 */
export class ReadinessGate {
  private readonly quietMs: number;
  private readonly minOutputBytes: number;
  private readonly maxWaitMs: number;
  private readonly fallbackQuietMs: number;
  private ready = false;
  private totalBytes = 0;
  private quietTimer: NodeJS.Timeout | undefined;
  private fallbackTimer: NodeJS.Timeout | undefined;
  private waiters: Array<() => void> = [];
  private readyListeners: Array<() => void> = [];

  constructor(options: ReadinessGateOptions = {}) {
    this.quietMs = options.quietMs ?? READY_QUIET_MS;
    this.minOutputBytes = options.minOutputBytes ?? READY_MIN_OUTPUT_BYTES;
    this.maxWaitMs = options.maxWaitMs ?? READY_WAIT_MAX_MS;
    this.fallbackQuietMs = options.fallbackQuietMs ?? READY_FALLBACK_QUIET_MS;
  }

  /** Call on every child output chunk (PtyProxy 'data') with its byte count. */
  notifyOutput(bytes: number): void {
    if (this.ready) return;
    this.totalBytes += bytes;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      if (this.totalBytes >= this.minOutputBytes) this.markReady();
    }, this.quietMs);
    this.quietTimer.unref();
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    this.fallbackTimer = setTimeout(() => this.markReady(), this.fallbackQuietMs);
    this.fallbackTimer.unref();
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Resolves when the child is ready, or after maxWaitMs — whichever comes
   * first. On timeout the caller proceeds with the injection anyway: a possibly
   * lost prompt beats refusing the command outright (the hub can observe the
   * pane and retry; a rejection would need the same recovery path for less
   * benefit).
   */
  waitUntilReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve();
      }, this.maxWaitMs);
      timeout.unref();
      const waiter = (): void => {
        clearTimeout(timeout);
        resolve();
      };
      this.waiters.push(waiter);
    });
  }

  /**
   * Subscribes to the one-time readiness latch. If already ready, the
   * callback fires immediately and synchronously (no double-fire on the
   * later latch, since it already happened). Distinct from waitUntilReady():
   * that resolves on timeout too and is meant for callers gating an action on
   * "best effort" readiness, whereas onReady() only ever fires on an actual
   * latch — never on a timeout.
   */
  onReady(cb: () => void): void {
    if (this.ready) {
      cb();
      return;
    }
    this.readyListeners.push(cb);
  }

  private markReady(): void {
    this.ready = true;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = undefined;
    if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    this.fallbackTimer = undefined;
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
    const listeners = this.readyListeners;
    this.readyListeners = [];
    for (const l of listeners) l();
  }
}
