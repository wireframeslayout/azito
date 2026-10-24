import { DEFAULT_RECOVERY_TIMING, NOTHING_TO_DO_WARNED, QUIET_OUTCOMES, afterAttempt, firstBackoff, type Backoff, type RecoveryTiming } from '../../../shared/recoveryBackoff';

/** How the watchdog sees the hub's own misao: everything it touches comes in here, so that it can be driven by a clock in a test. */
export interface LocalMisaoWatchdogDeps {
  /** The misao daemon AZITO installed for this hub does not answer. Rejects when that cannot be told. */
  isDown(): Promise<boolean>;
  /** Starts its task again; resolves with what it did (`started`, or why nothing was done). `force`: the task is still "running" but the daemon does not answer, so end it first. `busy`: an install / update holds the slot, nothing was done. */
  revive(force: boolean): Promise<string>;
  now(): number;
  logger: { info(message: string): void; warn(message: string): void };
}

/**
 * Brings back the hub's own misao on Windows when its daemon died, for as long as the hub runs: the same watchdog an agent's misao
 * has (`AgentRecoveryWatchdog`, same waits: `shared/recoveryBackoff.ts`), aimed at this machine.
 *
 * Why the hub does it: the misao task runs `conhost.exe --headless misao.exe ...` and conhost reports exit code 0 whatever its child
 * did, so the Task Scheduler never restarts it (`restartOnFailure.windows.test.ts`). A failure is first waited out for `baseMs` (an
 * update or a start may be in the middle of it), then an attempt is made, and the waits double up to `maxMs`. A task still "running"
 * while the daemon does not answer is left alone on the first attempt (it may be starting) and ended first from the second on. The
 * state is dropped as soon as the daemon answers. There is no state "stopped by the hub": nothing the hub does leaves this daemon
 * stopped (`azito misao update` stops and starts it inside its own slot, which the revive gives way to), so a daemon that does not
 * answer is one that died; a task disabled by hand is how to keep it stopped.
 *
 * Only the misao AZITO installed for this hub (`MisaoServiceService.reviveWindowsDaemon` says which: a `MISAO_SOCKET` set by hand or
 * another folder's task are left alone). While the hub is down nothing watches, and when the hub is back the daemon is brought back.
 */
export class LocalMisaoWatchdog {
  private wait: Backoff | undefined;
  /** The look going on; a tick that finds one still going on does nothing. */
  private looking: Promise<void> | undefined;
  private stopped = false;
  /** The `cannot be started` answer already warned about. */
  private warned: string | undefined;
  /** The last reason the daemon could not be looked at, so that the same one is warned about once. */
  private lastLookError: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: LocalMisaoWatchdogDeps, private readonly timing: RecoveryTiming = DEFAULT_RECOVERY_TIMING) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick(); }, this.timing.tickMs);
    this.timer.unref();
  }

  /** Ends the timer and starts nothing more; an attempt that has begun is left to finish ({@link drain}). */
  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Stops, then waits (at most `timeoutMs`) for the look that is going on, so that a restart of the daemon is not cut between its stop and its start. */
  async drain(timeoutMs: number): Promise<void> {
    this.stop();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
    try {
      await Promise.race([this.looking ?? Promise.resolve(), limit]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Looks at the daemon unless a look is still going on, and resolves when that look is over (the timer does not wait for it). */
  async tick(): Promise<void> {
    if (this.stopped || this.looking !== undefined) return;
    const look = this.look()
      .catch((err: unknown) => this.deps.logger.warn(`looking at the misao failed: ${describe(err)}`))
      .finally(() => { this.looking = undefined; });
    this.looking = look;
    await look;
  }

  private async look(): Promise<void> {
    let down: boolean;
    try {
      down = await this.deps.isDown();
      this.lastLookError = undefined;
    } catch (err) {
      const reason = describe(err);
      if (reason !== this.lastLookError) this.deps.logger.warn(`cannot tell whether the misao answers: ${reason}`);
      this.lastLookError = reason;
      return;
    }
    if (!down) {
      this.wait = undefined;
      this.warned = undefined;
      return;
    }
    const now = this.deps.now();
    if (this.wait === undefined) {
      this.wait = firstBackoff(now, '', this.timing);
      this.deps.logger.info(`the misao does not answer; trying to bring it back in ${this.timing.baseMs / 1000}s`);
      return;
    }
    if (now < this.wait.nextAt || this.stopped) return;
    const wait = this.wait;
    let outcome: string | undefined;
    try {
      outcome = await this.deps.revive(wait.attempts > 0);
    } catch (err) {
      this.deps.logger.warn(`could not bring the misao back: ${describe(err)}`);
    }
    if (outcome === 'busy') return; // an install / update holds it: not an attempt, look again next tick
    if (outcome !== undefined) this.report(outcome, wait.attempts + 1);
    this.wait = afterAttempt(wait, this.deps.now(), this.timing);
  }

  private report(outcome: string, attempt: number): void {
    if (QUIET_OUTCOMES.has(outcome)) return;
    if (NOTHING_TO_DO_WARNED.has(outcome)) {
      if (this.warned === outcome) return;
      this.warned = outcome;
      this.deps.logger.warn(`the misao does not answer and cannot be started again (${outcome}); it will keep being looked at, silently, until that changes`);
      return;
    }
    this.deps.logger.info(`tried to bring the misao back (attempt ${attempt}): ${outcome}`);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
