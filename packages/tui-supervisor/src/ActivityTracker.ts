import { EventEmitter } from 'node:events';
import type { ActivityState, AgentStatus } from './protocol';
import type { TitleAgentState } from './TitleStateTracker';

export interface ActivityTrackerOptions {
  /** Sliding window length used to sum output bytes. */
  windowMs?: number;
  /** Window byte sum at/above which the tracker transitions to 'active'. */
  activeThresholdBytes?: number;
  /** Silence duration after the last output required to transition to 'idle'. */
  idleAfterMs?: number;
  /** Evaluation tick interval. */
  tickMs?: number;
  /**
   * After a terminal resize, output for this long is NOT counted as activity.
   * A resize (SIGWINCH) makes a TUI agent repaint its whole screen, which is a
   * large output burst but not real work. Critically, when a browser attaches a
   * linked tmux session the WHOLE shared session resizes, so EVERY window's pane
   * gets SIGWINCH and every supervised agent would otherwise report 'active' at
   * once — making unrelated windows light up as running on focus.
   */
  resizeGraceMs?: number;
}

interface Sample {
  ts: number;
  bytes: number;
}

/** While 'active', re-emit the current state at this interval (keepalive for the hub). */
const ACTIVE_RESEND_MS = 15_000;

/**
 * Classifies the child agent's activity into 'active'/'idle' and emits
 * 'transition' (state, bytesInWindow, status?) on state changes, plus a
 * periodic 'active' re-send while activity continues.
 *
 * Two information sources, in priority order:
 * 1. Title state (setTitleState, fed from TitleStateTracker): once a title
 *    carrying a RECOGNIZED marker (working spinner / idle `✳` / blocked
 *    "Action Required") has been observed, it becomes the sole authority
 *    — working/blocked map to 'active' (with the corresponding status),
 *    idle maps to 'idle'. The byte-volume heuristic is disabled entirely in
 *    this mode, because it misreads keystroke echo as activity: Claude
 *    Code's TUI repaints its input box on every keypress, exceeding the
 *    byte threshold while the agent is actually idle.
 * 2. Byte-volume sliding window (record): the legacy heuristic, used while
 *    TitleStateTracker still reports 'unknown' — i.e. for agents that never
 *    set a pane title, and for those that only set titles this tracker cannot
 *    interpret (a static app name). Gating mode entry on a recognized marker
 *    (Issue #338) is what keeps such an agent from being reported permanently
 *    idle: an unrecognized title alone no longer disables the heuristic.
 */
export class ActivityTracker extends EventEmitter {
  private readonly windowMs: number;
  private readonly activeThresholdBytes: number;
  private readonly idleAfterMs: number;
  private readonly tickMs: number;
  private readonly resizeGraceMs: number;

  private samples: Sample[] = [];
  private state: ActivityState = 'idle';
  /** Last tick at which the window sum was at/above the active threshold. */
  private lastAboveThresholdTs = 0;
  private lastActiveEmitTs = 0;
  private resizeGraceUntil = 0;
  private timer: NodeJS.Timeout | undefined;
  /** Latest classified title state — 'unknown' until a title is first observed. */
  private titleState: TitleAgentState = 'unknown';
  /** Status carried by the last 'active' emit (title mode only). */
  private emittedStatus: AgentStatus | undefined;

  constructor(options: ActivityTrackerOptions = {}) {
    super();
    this.windowMs = options.windowMs ?? 3_000;
    this.activeThresholdBytes = options.activeThresholdBytes ?? 200;
    this.idleAfterMs = options.idleAfterMs ?? 5_000;
    this.tickMs = options.tickMs ?? 1_000;
    this.resizeGraceMs = options.resizeGraceMs ?? 800;
  }

  /** Call when the terminal was resized; suppresses the repaint burst that follows. */
  notifyResize(): void {
    this.resizeGraceUntil = Date.now() + this.resizeGraceMs;
  }

  /**
   * Feed the latest title-derived state (from TitleStateTracker). Anything
   * other than 'unknown' switches the tracker into title mode for good —
   * TitleStateTracker only leaves 'unknown' after observing a recognized
   * marker (so the child provably drives its title with this protocol), and
   * never reverts once it has.
   */
  setTitleState(state: TitleAgentState): void {
    if (state === 'unknown') return;
    this.titleState = state;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    // Never keep the supervisor process alive just for activity tracking.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  record(bytes: number): void {
    const now = Date.now();
    // Within the post-resize grace, treat output as a repaint (not activity):
    // its bytes are dropped, so a resize can neither light up an idle agent
    // nor keep an active one alive by itself.
    if (now < this.resizeGraceUntil) return;
    this.samples.push({ ts: now, bytes });
  }

  getState(): ActivityState {
    return this.state;
  }

  private tick(): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    this.samples = this.samples.filter((s) => s.ts >= cutoff);
    const sum = this.samples.reduce((acc, s) => acc + s.bytes, 0);

    // Title mode: a classifiable OSC title has been observed at least once —
    // it is the sole authority from then on (see class doc).
    if (this.titleState !== 'unknown') {
      this.tickTitleMode(now, sum);
      return;
    }

    const above = sum >= this.activeThresholdBytes;
    if (above) this.lastAboveThresholdTs = now;

    if (this.state === 'idle') {
      if (above) {
        this.state = 'active';
        this.lastActiveEmitTs = now;
        this.emit('transition', 'active', sum);
      }
      return;
    }

    // state === 'active'.
    // Idle is measured from the last tick whose window sum was *above the
    // threshold* — not from the last byte seen. An idle TUI still dribbles a
    // few bytes (cursor blink, prompt redraw); keying off the last byte let
    // that trickle postpone 'idle' indefinitely, so the spinner lingered long
    // after the agent had actually finished.
    if (!above && now - this.lastAboveThresholdTs >= this.idleAfterMs) {
      this.state = 'idle';
      this.emit('transition', 'idle', sum);
    } else if (now - this.lastActiveEmitTs >= ACTIVE_RESEND_MS) {
      this.lastActiveEmitTs = now;
      this.emit('transition', 'active', sum);
    }
  }

  /**
   * Title-mode evaluation: working/blocked → 'active' (carrying the status),
   * idle → 'idle'. Emits on any (state, status) change — including a
   * working↔blocked flip while staying 'active' — plus the same periodic
   * 'active' keepalive as the byte heuristic.
   */
  private tickTitleMode(now: number, sum: number): void {
    const desired: ActivityState = this.titleState === 'idle' ? 'idle' : 'active';
    const status: AgentStatus | undefined =
      this.titleState === 'working' ? 'working'
      : this.titleState === 'blocked' ? 'blocked'
      : undefined;

    if (desired !== this.state || (desired === 'active' && status !== this.emittedStatus)) {
      this.state = desired;
      this.emittedStatus = desired === 'active' ? status : undefined;
      this.lastActiveEmitTs = now;
      this.emit('transition', desired, sum, this.emittedStatus);
      return;
    }
    if (this.state === 'active' && now - this.lastActiveEmitTs >= ACTIVE_RESEND_MS) {
      this.lastActiveEmitTs = now;
      this.emit('transition', 'active', sum, this.emittedStatus);
    }
  }
}
