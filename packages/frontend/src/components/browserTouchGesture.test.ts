import { describe, expect, it } from 'vitest';
import { BrowserTouchGesture, TAP_MOVE_THRESHOLD_PX } from './browserTouchGesture';

describe('BrowserTouchGesture', () => {
  it('treats sub-threshold movement as a tap with no wheel flush', () => {
    const gesture = new BrowserTouchGesture();
    gesture.start(100, 100);
    gesture.accumulate(102, 101); // displacement < TAP_MOVE_THRESHOLD_PX
    expect(gesture.isScrolling()).toBe(false);

    const result = gesture.end();
    expect(result).toEqual({ type: 'tap' });
  });

  it('starts flushing once the threshold is crossed, including prior accumulation', () => {
    const gesture = new BrowserTouchGesture();
    gesture.start(0, 0);
    // Small pre-threshold move: accumulated but must not be reported yet.
    gesture.accumulate(3, 0);
    expect(gesture.isScrolling()).toBe(false);

    // Crosses TAP_MOVE_THRESHOLD_PX from the start point.
    gesture.accumulate(TAP_MOVE_THRESHOLD_PX + 5, 0);
    expect(gesture.isScrolling()).toBe(true);

    // The flush must include everything accumulated since touchstart (3 +
    // the rest of the move), not just the delta since crossing.
    const pending = gesture.takePending();
    expect(pending.dx).toBe(TAP_MOVE_THRESHOLD_PX + 5);
    expect(pending.dy).toBe(0);

    // Once resolved as a swipe, touchend must not also register a tap.
    gesture.accumulate(TAP_MOVE_THRESHOLD_PX + 5, 4);
    const end = gesture.end();
    expect(end).toEqual({ type: 'flush', dx: 0, dy: 4 });
  });

  it('classifies a wobble back toward the start point as a tap (max displacement, not path length)', () => {
    const gesture = new BrowserTouchGesture();
    gesture.start(50, 50);
    // Large total path length, but every point stays within the threshold
    // of the start point.
    gesture.accumulate(54, 50);
    gesture.accumulate(47, 50);
    gesture.accumulate(53, 50);
    gesture.accumulate(50, 50);
    expect(gesture.isScrolling()).toBe(false);

    const result = gesture.end();
    expect(result).toEqual({ type: 'tap' });
  });

  it('discards state on cancel so neither a flush nor a tap follows', () => {
    const gesture = new BrowserTouchGesture();
    gesture.start(0, 0);
    gesture.accumulate(TAP_MOVE_THRESHOLD_PX + 20, 0);
    expect(gesture.isScrolling()).toBe(true);

    gesture.cancel();

    expect(gesture.isScrolling()).toBe(false);
    expect(gesture.hasPending()).toBe(false);
    expect(gesture.end()).toEqual({ type: 'none' });
  });

  it('reports no flush at touchend when a swipe has nothing pending', () => {
    const gesture = new BrowserTouchGesture();
    gesture.start(0, 0);
    gesture.accumulate(TAP_MOVE_THRESHOLD_PX + 20, 0);
    gesture.takePending(); // already flushed by a touchmove tick
    expect(gesture.end()).toEqual({ type: 'none' });
  });
});
