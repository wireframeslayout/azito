import { EventEmitter } from 'node:events';
import type { PaneAgentState } from '@azito/shared';
import type { ActivityState, AgentStatus, ActivityDecidedBy } from './protocol';
import type { TitleAgentState } from './TitleStateTracker';

export interface ActivityTrackerOptions {
  /** Sliding window length used to sum output bytes (S3). */
  windowMs?: number;
  /** Window byte sum at/above which S3 transitions to 'active'. */
  activeThresholdBytes?: number;
  /** Silence duration after the last output required for S3 to transition to 'idle'. */
  idleAfterMs?: number;
  /** Evaluation tick interval (S3 and the keepalive re-send). */
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
  /**
   * After a keystroke (or any bytes written INTO the child PTY), output for
   * this long is NOT counted as activity. A TUI agent repaints its input box on
   * every keystroke — Claude Code redraws the whole prompt frame, several
   * hundred bytes per key — so merely typing a prompt would otherwise push the
   * byte window over the threshold on consecutive ticks and light the window
   * up as 'active'. Real agent work produces output long after the last input
   * byte, so gating on input quiet time separates the two without thresholds.
   */
  inputGraceMs?: number;
}

interface Sample {
  ts: number;
  bytes: number;
}

/** While 'active', re-emit the current state at this interval (keepalive for the hub). */
const ACTIVE_RESEND_MS = 15_000;
/** S3: consecutive above-threshold ticks needed before idle→active (echo filter). */
const ACTIVE_CONSECUTIVE_TICKS = 2;
/**
 * S1 working→idle hold: a screen that reads idle is re-evaluated every
 * IDLE_RECHECK_MS and published only after IDLE_CONFIRMATIONS consecutive idle
 * readings, or once IDLE_HOLD_CAP_MS has elapsed. Claude Code clears the
 * spinner line and paints the prompt box over several frames, so a single
 * idle frame in between is not a completed turn. Every other transition
 * (→working, →blocked) is immediate. Values follow herdr's
 * AGENT_PENDING_IDLE_* constants.
 */
const IDLE_RECHECK_MS = 100;
const IDLE_CONFIRMATIONS = 3;
const IDLE_HOLD_CAP_MS = 700;

export type DecidedBy = ActivityDecidedBy;

/**
 * Classifies the child agent's activity into 'active'/'idle' and emits
 * 'transition' (state, bytesInWindow, status?, decidedBy) on state changes,
 * plus a periodic 'active' re-send while activity continues.
 *
 * Three information sources, evaluated top-down; the first rung that has an
 * opinion decides (see runLadder):
 * - S1 screen (`setScreenState`, fed by ScreenStateTracker): the reconstructed
 *   pane content classified by the shared screen rules — the primary source,
 *   because Claude Code ≥2.1.236 under tmux never animates its title anymore
 *   (it is pinned to `✳ <topic>`), while the spinner line and the permission /
 *   AskUserQuestion dialogs are still drawn on screen.
 * - S2 title (`setTitleState`, fed by TitleStateTracker): OSC 0/2 title
 *   glyphs. Still authoritative for codex (`Action Required`, braille spinner)
 *   and for Claude Code ≤2.1.234; once a working/blocked title has been seen
 *   the rung stays enabled (`titleAuthoritative`).
 * - S3 bytes (`record`): the byte-volume sliding window with resize/input
 *   grace and the consecutive-tick echo filter — the last resort for generic
 *   TUIs and screens no rule recognises. Unchanged from the pre-S1 design.
 */
export class ActivityTracker extends EventEmitter {
  private readonly windowMs: number;
  private readonly activeThresholdBytes: number;
  private readonly idleAfterMs: number;
  private readonly tickMs: number;
  private readonly resizeGraceMs: number;
  private readonly inputGraceMs: number;

  private samples: Sample[] = [];
  private state: ActivityState = 'idle';
  private lastAboveThresholdTs = 0;
  private lastActiveEmitTs = 0;
  private resizeGraceUntil = 0;
  private inputGraceUntil = 0;
  private timer: NodeJS.Timeout | undefined;
  private titleState: TitleAgentState = 'unknown';
  private titleAuthoritative = false;
  private aboveStreak = 0;
  private freshBytes = false;
  private emittedStatus: AgentStatus | undefined;
  private emittedDecidedBy: DecidedBy | undefined;

  private screenState: PaneAgentState = 'unknown';
  private idleHoldStart: number | undefined;
  private idleHoldCount = 0;
  private idleHoldTimer: NodeJS.Timeout | undefined;

  constructor(options: ActivityTrackerOptions = {}) {
    super();
    this.windowMs = options.windowMs ?? 3_000;
    this.activeThresholdBytes = options.activeThresholdBytes ?? 200;
    this.idleAfterMs = options.idleAfterMs ?? 5_000;
    this.tickMs = options.tickMs ?? 1_000;
    this.resizeGraceMs = options.resizeGraceMs ?? 800;
    this.inputGraceMs = options.inputGraceMs ?? 500;
  }

  /**
   * Call when bytes were written into the child PTY (user keystrokes forwarded
   * from stdin, or hub-injected input). Output within the following
   * inputGraceMs is treated as echo / input-box repaint, not activity (S3 only —
   * S1 reads the reconstructed screen and is not fooled by echo).
   */
  notifyInput(): void {
    this.inputGraceUntil = Date.now() + this.inputGraceMs;
  }

  /** Call when the terminal was resized; suppresses the repaint burst that follows (S3). */
  notifyResize(): void {
    this.resizeGraceUntil = Date.now() + this.resizeGraceMs;
  }

  setTitleState(state: TitleAgentState): void {
    if (state === 'unknown') return;
    this.titleState = state;
    if (state === 'working' || state === 'blocked') {
      this.titleAuthoritative = true;
    }
  }

  /**
   * Feed the latest screen-derived state (S1). 'unknown' hands the decision
   * down to S2/S3. Evaluated immediately rather than on the next tick so that
   * idle→working and →blocked reach the hub without the tick latency.
   */
  setScreenState(state: PaneAgentState): void {
    this.screenState = state;
    this.evaluateNow();
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
    if (this.idleHoldTimer) clearTimeout(this.idleHoldTimer);
    this.idleHoldTimer = undefined;
  }

  record(bytes: number): void {
    const now = Date.now();
    // Within the post-resize grace, treat output as a repaint (not activity):
    // its bytes are dropped, so a resize can neither light up an idle agent
    // nor keep an active one alive by itself.
    if (now < this.resizeGraceUntil) return;
    // Within the post-input grace, treat output as keystroke echo / prompt
    // repaint: typing must never light the window up, and (while active) it
    // must not extend activity by itself either.
    if (now < this.inputGraceUntil) return;
    this.samples.push({ ts: now, bytes });
    this.freshBytes = true;
  }

  getState(): ActivityState {
    return this.state;
  }

  getSnapshot(): { state: ActivityState; bytesInWindow: number; status?: AgentStatus; decidedBy?: DecidedBy } {
    const cutoff = Date.now() - this.windowMs;
    const sum = this.samples.filter((s) => s.ts >= cutoff).reduce((acc, s) => acc + s.bytes, 0);
    return {
      state: this.state,
      bytesInWindow: sum,
      ...(this.emittedStatus !== undefined ? { status: this.emittedStatus } : {}),
      ...(this.emittedDecidedBy !== undefined ? { decidedBy: this.emittedDecidedBy } : {}),
    };
  }

  private evaluateNow(): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const sum = this.samples.filter((s) => s.ts >= cutoff).reduce((acc, s) => acc + s.bytes, 0);
    this.runLadder(now, sum);
  }

  private tick(): void {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    this.samples = this.samples.filter((s) => s.ts >= cutoff);
    const sum = this.samples.reduce((acc, s) => acc + s.bytes, 0);
    this.runLadder(now, sum);
  }

  private runLadder(now: number, sum: number): void {
    // S1: screen
    if (this.screenState !== 'unknown') {
      this.applyClassified(now, sum, this.screenState, 'screen');
      return;
    }
    // S2: title
    if (this.titleAuthoritative || this.titleState === 'working' || this.titleState === 'blocked') {
      if (this.titleState === 'working' || this.titleState === 'blocked') {
        this.titleAuthoritative = true;
      }
      this.applyClassified(now, sum, this.titleState as PaneAgentState, 'title');
      return;
    }
    // S3: bytes
    this.tickCombinedMode(now, sum);
  }

  /**
   * S1/S2 shared state application: working/blocked → 'active' (carrying the
   * status), idle → 'idle'. Emits on any (state, status, decidedBy) change —
   * including a working↔blocked flip while staying 'active' — plus the same
   * periodic 'active' keepalive as S3. Only a screen-derived working→idle is
   * held for confirmation (see IDLE_* constants).
   */
  private applyClassified(now: number, sum: number, s: PaneAgentState, by: DecidedBy): void {
    const desired: ActivityState = s === 'idle' ? 'idle' : 'active';
    const status: AgentStatus | undefined =
      s === 'working' ? 'working' : s === 'blocked' ? 'blocked' : undefined;

    if (desired === 'idle' && this.state === 'active' && by === 'screen') {
      if (!this.holdIdle(now)) return;
    } else {
      this.resetIdleHold();
    }

    if (
      desired !== this.state ||
      (desired === 'active' && status !== this.emittedStatus) ||
      by !== this.emittedDecidedBy
    ) {
      this.state = desired;
      this.emittedStatus = desired === 'active' ? status : undefined;
      this.emittedDecidedBy = by;
      this.lastActiveEmitTs = now;
      this.emit('transition', desired, sum, this.emittedStatus, by);
      return;
    }
    if (this.state === 'active' && now - this.lastActiveEmitTs >= ACTIVE_RESEND_MS) {
      this.lastActiveEmitTs = now;
      this.emit('transition', 'active', sum, this.emittedStatus, by);
    }
  }

  private holdIdle(now: number): boolean {
    if (this.idleHoldStart === undefined) {
      this.idleHoldStart = now;
      this.idleHoldCount = 1;
      this.scheduleIdleRecheck();
      return false;
    }
    this.idleHoldCount++;
    if (this.idleHoldCount >= IDLE_CONFIRMATIONS || now - this.idleHoldStart >= IDLE_HOLD_CAP_MS) {
      this.resetIdleHold();
      return true;
    }
    this.scheduleIdleRecheck();
    return false;
  }

  private scheduleIdleRecheck(): void {
    if (this.idleHoldTimer) clearTimeout(this.idleHoldTimer);
    this.idleHoldTimer = setTimeout(() => {
      this.idleHoldTimer = undefined;
      this.evaluateNow();
    }, IDLE_RECHECK_MS);
    this.idleHoldTimer.unref();
  }

  private resetIdleHold(): void {
    this.idleHoldStart = undefined;
    this.idleHoldCount = 0;
    if (this.idleHoldTimer) clearTimeout(this.idleHoldTimer);
    this.idleHoldTimer = undefined;
  }

  /**
   * S3: byte-volume heuristic with echo filter, plus instant promotion to the
   * title rung on a working/blocked title. Unchanged from the combined mode
   * that preceded S1 (PR #123 / #146).
   */
  private tickCombinedMode(now: number, sum: number): void {
    if (this.titleState === 'working' || this.titleState === 'blocked') {
      this.titleAuthoritative = true;
      this.applyClassified(now, sum, this.titleState as PaneAgentState, 'title');
      return;
    }

    const above = sum >= this.activeThresholdBytes && this.freshBytes;
    this.freshBytes = false;
    this.aboveStreak = above ? this.aboveStreak + 1 : 0;
    if (above) this.lastAboveThresholdTs = now;

    if (this.state === 'idle') {
      if (this.aboveStreak >= ACTIVE_CONSECUTIVE_TICKS) {
        this.state = 'active';
        this.emittedDecidedBy = 'bytes';
        this.lastActiveEmitTs = now;
        this.emit('transition', 'active', sum, undefined, 'bytes');
      }
      return;
    }

    if (!above && now - this.lastAboveThresholdTs >= this.idleAfterMs) {
      this.state = 'idle';
      this.emittedDecidedBy = 'bytes';
      this.emit('transition', 'idle', sum, undefined, 'bytes');
    } else if (now - this.lastActiveEmitTs >= ACTIVE_RESEND_MS) {
      this.lastActiveEmitTs = now;
      this.emit('transition', 'active', sum, undefined, 'bytes');
    }
  }
}
