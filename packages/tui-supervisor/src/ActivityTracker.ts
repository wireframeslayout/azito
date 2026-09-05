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

/** Consecutive above-threshold ticks needed before idle→active (echo filter). */
const ACTIVE_CONSECUTIVE_TICKS = 2;

/**
 * Classifies the child agent's activity into 'active'/'idle' and emits
 * 'transition' (state, bytesInWindow, status?) on state changes, plus a
 * periodic 'active' re-send while activity continues.
 *
 * Two information sources, combined in a priority ladder:
 * 1. Title-authoritative mode (entered once a `working` or `blocked` title is
 *    observed): the title is the sole authority — working/blocked → active
 *    (with status), idle → idle. The byte heuristic is fully disabled. Codex
 *    and Claude Code ≤2.1.234 (which animate their pane title with a working
 *    spinner) enter this mode immediately.
 * 2. Combined mode (default — including Claude Code ≥2.1.236 on tmux, which
 *    only sets a static `✳ <topic>` title and never writes a working spinner):
 *    the byte-volume sliding window decides idle/active, with an echo filter
 *    requiring the threshold to be exceeded for ACTIVE_CONSECUTIVE_TICKS
 *    consecutive ticks before transitioning to active. A `working` or `blocked`
 *    title promotes the tracker to title-authoritative mode immediately.
 *
 * An idle marker (`✳ `) alone does NOT disable the byte heuristic — Claude Code
 * ≥2.1.236 on tmux never writes a working spinner, so a tracker that treated
 * `idle` as authoritative would report permanently idle.
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
  /** True once a 'working' or 'blocked' title has been observed — byte heuristic is fully disabled. */
  private titleAuthoritative = false;
  /** Consecutive ticks where fresh output pushed the window sum above the active threshold. */
  private aboveStreak = 0;
  /** Whether any bytes were recorded since the last tick (reset by tick). */
  private freshBytes = false;
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
   * other than 'unknown' updates the title state; `working` or `blocked`
   * additionally locks the tracker into title-authoritative mode for good.
   */
  setTitleState(state: TitleAgentState): void {
    if (state === 'unknown') return;
    this.titleState = state;
    if (state === 'working' || state === 'blocked') {
      this.titleAuthoritative = true;
    }
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
    this.freshBytes = true;
  }

  getState(): ActivityState {
    return this.state;
  }

  getSnapshot(): { state: ActivityState; bytesInWindow: number; status?: AgentStatus } {
    const cutoff = Date.now() - this.windowMs;
    const sum = this.samples.filter((s) => s.ts >= cutoff).reduce((acc, s) => acc + s.bytes, 0);
    return {
      state: this.state,
      bytesInWindow: sum,
      ...(this.emittedStatus !== undefined ? { status: this.emittedStatus } : {}),
    };
  }

  private tick(): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    this.samples = this.samples.filter((s) => s.ts >= cutoff);
    const sum = this.samples.reduce((acc, s) => acc + s.bytes, 0);

    if (this.titleAuthoritative) {
      this.tickTitleMode(now, sum);
      return;
    }
    this.tickCombinedMode(now, sum);
  }

  /**
   * Combined mode: byte-volume heuristic with echo filter, plus instant
   * promotion to title-authoritative on a working/blocked title.
   */
  private tickCombinedMode(now: number, sum: number): void {
    if (this.titleState === 'working' || this.titleState === 'blocked') {
      this.titleAuthoritative = true;
      this.tickTitleMode(now, sum);
      return;
    }

    const above = sum >= this.activeThresholdBytes && this.freshBytes;
    this.freshBytes = false;
    this.aboveStreak = above ? this.aboveStreak + 1 : 0;
    if (above) this.lastAboveThresholdTs = now;

    if (this.state === 'idle') {
      if (this.aboveStreak >= ACTIVE_CONSECUTIVE_TICKS) {
        this.state = 'active';
        this.lastActiveEmitTs = now;
        this.emit('transition', 'active', sum);
      }
      return;
    }

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
