import { EventEmitter } from 'node:events';
import type { PaneAgentState } from '@azito/shared';
import type { ActivityState, AgentStatus, ActivityDecidedBy } from './protocol';
import type { TitleAgentState } from './TitleStateTracker';

export interface ActivityTrackerOptions {
  windowMs?: number;
  activeThresholdBytes?: number;
  idleAfterMs?: number;
  tickMs?: number;
  resizeGraceMs?: number;
  inputGraceMs?: number;
}

interface Sample {
  ts: number;
  bytes: number;
}

const ACTIVE_RESEND_MS = 15_000;
const ACTIVE_CONSECUTIVE_TICKS = 2;
const IDLE_RECHECK_MS = 100;
const IDLE_CONFIRMATIONS = 3;
const IDLE_HOLD_CAP_MS = 700;

export type DecidedBy = ActivityDecidedBy;

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

  notifyInput(): void {
    this.inputGraceUntil = Date.now() + this.inputGraceMs;
  }

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

  setScreenState(state: PaneAgentState): void {
    this.screenState = state;
    this.evaluateNow();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
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
    if (now < this.resizeGraceUntil) return;
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
