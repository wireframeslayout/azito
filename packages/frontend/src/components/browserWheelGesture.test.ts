import { describe, it, expect } from 'vitest';
import {
  WheelVelocityTracker,
  BrowserWheelInertia,
  decayVelocity,
  inertiaDisplacement,
  INERTIA_MIN_VELOCITY,
  INERTIA_HALF_LIFE_MS,
  TOUCH_END_STALE_MS,
} from './browserWheelGesture';

describe('WheelVelocityTracker.releaseVelocity', () => {
  it('weighs the recent span higher than the full-swipe average when the swipe accelerates near the end', () => {
    const tracker = new WheelVelocityTracker();
    // Slow start, then a fast flick right before release.
    tracker.addSample(0, 0, 0);
    tracker.addSample(2, 0, 20);
    tracker.addSample(4, 0, 40);
    tracker.addSample(6, 0, 60);
    tracker.addSample(10, 0, 80);
    tracker.addSample(16, 0, 100);

    const { vx } = tracker.releaseVelocity(100);
    const fullSwipeAverage = (16 - 0) / (100 - 0);

    expect(vx).toBeGreaterThan(fullSwipeAverage);
    // Sanity: matches the recent-span (t=60..100) computation by hand.
    expect(vx).toBeCloseTo((16 - 6) / (100 - 60), 10);
  });

  it('returns zero velocity when there are no samples', () => {
    const tracker = new WheelVelocityTracker();
    expect(tracker.releaseVelocity(1000)).toEqual({ vx: 0, vy: 0 });
  });

  // Regression: with only two samples 60ms apart, the older one falls
  // *outside* the 50ms recent span (VELOCITY_RECENT_SPAN_MS) measured back
  // from the last sample — so a naive "oldest sample within the recent
  // span" search finds no candidate other than the last sample itself,
  // which would make it its own base (dt=0 -> velocity 0) despite there
  // being a perfectly good earlier sample to use. Must fall back to the
  // immediately preceding sample instead of returning zero.
  it('falls back to the immediately preceding sample when no sample falls within the recent span (sparse samples)', () => {
    const tracker = new WheelVelocityTracker();
    tracker.addSample(0, 0, 0);
    tracker.addSample(12, 0, 60);

    const { vx } = tracker.releaseVelocity(60);
    expect(vx).not.toBe(0);
    expect(vx).toBeCloseTo((12 - 0) / (60 - 0), 10);
  });

  it('does not go stale 90ms after the last move (within TOUCH_END_STALE_MS)', () => {
    const tracker = new WheelVelocityTracker();
    tracker.addSample(0, 0, 0);
    tracker.addSample(5, 0, 30);

    const { vx } = tracker.releaseVelocity(30 + 90);
    expect(vx).not.toBe(0);
  });

  it('goes stale 110ms after the last move (beyond TOUCH_END_STALE_MS)', () => {
    const tracker = new WheelVelocityTracker();
    tracker.addSample(0, 0, 0);
    tracker.addSample(5, 0, 30);

    expect(30 + 110 - 30).toBeGreaterThan(TOUCH_END_STALE_MS);
    const { vx, vy } = tracker.releaseVelocity(30 + 110);
    expect(vx).toBe(0);
    expect(vy).toBe(0);
  });
});

describe('decayVelocity / inertiaDisplacement — split invariance', () => {
  // The whole point of integrating analytically per-frame (rather than a
  // naive v*dt Euler step) is that splitting the same total duration into
  // different frame-rate/jitter patterns must not change the total
  // displacement — a delayed frame must not overshoot.
  it('produces (nearly) the same total displacement whether split into 60Hz, 120Hz, or irregular/delayed frames', () => {
    const v0 = 0.5; // px/ms
    const totalMs = 300;

    const runSplit = (frameDurationsMs: number[]): number => {
      let elapsed = 0;
      let total = 0;
      for (const dt of frameDurationsMs) {
        const vAtStart = decayVelocity(v0, elapsed);
        total += inertiaDisplacement(vAtStart, dt);
        elapsed += dt;
      }
      return total;
    };

    const frames60Hz = Array.from({ length: Math.round(totalMs / (1000 / 60)) }, () => 1000 / 60);
    const frames120Hz = Array.from({ length: Math.round(totalMs / (1000 / 120)) }, () => 1000 / 120);
    // Irregular/delayed frames (e.g. a dropped frame here and there), same total.
    const irregular = [10, 40, 5, 60, 15, 30, 90, 50];
    expect(irregular.reduce((a, b) => a + b, 0)).toBe(totalMs);

    const total60 = runSplit(frames60Hz);
    const total120 = runSplit(frames120Hz);
    const totalIrregular = runSplit(irregular);

    // Closed-form total displacement over [0, totalMs], re-deriving τ from
    // the exported half-life constant the same way the module does
    // internally (τ is not itself exported).
    const tau = INERTIA_HALF_LIFE_MS / Math.LN2;
    const closedForm = v0 * tau * (1 - Math.exp(-totalMs / tau));

    expect(total60).toBeCloseTo(closedForm, 6);
    expect(total120).toBeCloseTo(closedForm, 6);
    expect(totalIrregular).toBeCloseTo(closedForm, 6);
  });
});

describe('BrowserWheelInertia — 2D behavior', () => {
  it('preserves the dx/dy ratio of a diagonal flick across many frames', () => {
    const vx0 = 0.8;
    const vy0 = 0.4; // exactly half of vx0
    const inertia = new BrowserWheelInertia(vx0, vy0);

    let totalDx = 0;
    let totalDy = 0;
    const dt = 16; // ~60Hz
    for (let i = 0; i < 60 && !inertia.done; i++) {
      const { x, y } = inertia.step(dt);
      totalDx += x;
      totalDy += y;
    }

    expect(totalDx).toBeGreaterThan(0);
    expect(totalDy).toBeGreaterThan(0);
    expect(totalDx / totalDy).toBeCloseTo(vx0 / vy0, 6);
  });

  it('reports done immediately when the release velocity magnitude is below the threshold', () => {
    const belowThreshold = INERTIA_MIN_VELOCITY / 2;
    const inertia = new BrowserWheelInertia(belowThreshold, 0);
    expect(inertia.done).toBe(true);
  });

  it('reports not done immediately when the release velocity magnitude is above the threshold', () => {
    const inertia = new BrowserWheelInertia(1, 1);
    expect(inertia.done).toBe(false);
  });

  it('eventually becomes done as velocity decays below the threshold', () => {
    const inertia = new BrowserWheelInertia(1, 0);
    let steps = 0;
    while (!inertia.done && steps < 10000) {
      inertia.step(16);
      steps++;
    }
    expect(inertia.done).toBe(true);
    expect(steps).toBeGreaterThan(0);
    expect(steps).toBeLessThan(10000);
  });
});
