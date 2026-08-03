// Pure tap-vs-swipe gesture state machine for BrowserView's touch handling.
// Kept free of DOM/React so it can be unit-tested under vitest's 'node'
// environment (see browserTouchGesture.test.ts) — BrowserView.tsx wires this
// up to actual TouchEvents, coordinate scaling, and WS sends.

// Movement (in CSS px) below which a touch sequence is treated as a tap
// rather than a swipe. Judged against the *maximum displacement from the
// start point*, not accumulated path length, so a finger that wobbles back
// toward its start (large total path, small net displacement) still counts
// as a tap.
export const TAP_MOVE_THRESHOLD_PX = 8;

export interface PendingDelta {
  dx: number;
  dy: number;
}

export type BrowserTouchEndResult =
  | { type: 'tap' }
  | { type: 'flush'; dx: number; dy: number }
  | { type: 'none' };

/**
 * Tracks a single touch sequence (touchstart..touchend/touchcancel) and
 * decides, as movement comes in, whether it is (still) a tap candidate or
 * has become a swipe — and if a swipe, accumulates the finger movement not
 * yet flushed as a wheel delta.
 *
 * Threshold semantics: while under TAP_MOVE_THRESHOLD_PX, movement is only
 * accumulated (no wheel is sent yet, so a tap never produces a stray
 * scroll). The instant the threshold is crossed, the caller's next flush
 * includes everything accumulated since touchstart — no movement is lost by
 * having withheld it pre-threshold.
 */
export class BrowserTouchGesture {
  private active = false;
  private scrolling = false;
  private startX = 0;
  private startY = 0;
  private lastX = 0;
  private lastY = 0;
  private maxDisplacement = 0;
  private pendingDx = 0;
  private pendingDy = 0;

  start(x: number, y: number): void {
    this.active = true;
    this.scrolling = false;
    this.startX = x;
    this.startY = y;
    this.lastX = x;
    this.lastY = y;
    this.maxDisplacement = 0;
    this.pendingDx = 0;
    this.pendingDy = 0;
  }

  /** Accumulates finger movement and updates the tap/swipe classification. */
  accumulate(x: number, y: number): void {
    if (!this.active) return;
    this.pendingDx += x - this.lastX;
    this.pendingDy += y - this.lastY;
    this.lastX = x;
    this.lastY = y;
    const displacement = Math.hypot(x - this.startX, y - this.startY);
    if (displacement > this.maxDisplacement) this.maxDisplacement = displacement;
    if (!this.scrolling && this.maxDisplacement >= TAP_MOVE_THRESHOLD_PX) {
      this.scrolling = true;
    }
  }

  /** Once a sequence has crossed the tap threshold, it stays a swipe. */
  isScrolling(): boolean {
    return this.scrolling;
  }

  /** Pulls the accumulated-but-unflushed delta, resetting it to zero. */
  takePending(): PendingDelta {
    const delta = { dx: this.pendingDx, dy: this.pendingDy };
    this.pendingDx = 0;
    this.pendingDy = 0;
    return delta;
  }

  hasPending(): boolean {
    return this.pendingDx !== 0 || this.pendingDy !== 0;
  }

  /**
   * Resolves the sequence at touchend: a swipe flushes any remaining
   * movement, a tap (never crossed the threshold) reports 'tap' and
   * discards whatever sub-threshold jitter had been accumulating.
   */
  end(): BrowserTouchEndResult {
    if (!this.active) return { type: 'none' };
    this.active = false;
    if (!this.scrolling) return { type: 'tap' };
    if (!this.hasPending()) return { type: 'none' };
    const { dx, dy } = this.takePending();
    return { type: 'flush', dx, dy };
  }

  /** Discards all in-flight state; no flush or tap must follow. */
  cancel(): void {
    this.active = false;
    this.scrolling = false;
    this.pendingDx = 0;
    this.pendingDy = 0;
  }
}
