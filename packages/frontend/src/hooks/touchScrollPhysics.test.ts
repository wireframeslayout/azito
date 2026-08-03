import { describe, expect, it } from 'vitest';
import {
  DeltaAccumulator,
  INERTIA_HALF_LIFE_MS,
  TOUCH_END_STALE_MS,
  VELOCITY_RECENT_SPAN_MS,
  VELOCITY_WINDOW_MS,
  VelocityTracker,
  decayVelocity,
} from './touchScrollPhysics';

describe('VelocityTracker', () => {
  it('等速サンプル列から正しい速度が出る', () => {
    const tracker = new VelocityTracker();
    tracker.add(0, 0);
    tracker.add(8, 16);
    tracker.add(16, 32);
    tracker.add(24, 48);
    tracker.add(32, 64);

    expect(tracker.velocityAt(64)).toBeCloseTo(0.5, 10);
  });

  it('ウィンドウ外の古いサンプルが速度に影響しない（序盤高速→直近低速）', () => {
    const tracker = new VelocityTracker();
    // 序盤: 50ms で 1000px 移動する高速フェーズ
    tracker.add(0, 0);
    tracker.add(1000, 50);
    // 間隔を空けて直近の低速フェーズへ（ウィンドウ100msより古いサンプルは破棄される）
    tracker.add(1005, 960);
    tracker.add(1010, 1000);

    // 高速フェーズの影響が残っていれば速度は大きくなるはずだが、
    // 直近の低速フェーズのみが反映されることを確認する
    expect(tracker.velocityAt(1000)).toBeCloseTo(0.125, 10);
  });

  it('サンプルが1個以下なら速度は0', () => {
    const empty = new VelocityTracker();
    expect(empty.velocityAt(0)).toBe(0);

    const single = new VelocityTracker();
    single.add(0, 0);
    expect(single.velocityAt(0)).toBe(0);
  });

  it('最終サンプルから TOUCH_END_STALE_MS 経過後は0（指を止めてから離すケース）', () => {
    const tracker = new VelocityTracker();
    tracker.add(0, 0);
    tracker.add(10, 20);

    expect(tracker.velocityAt(20 + TOUCH_END_STALE_MS)).toBe(0);
    // ちょうど閾値未満なら0にならない
    expect(tracker.velocityAt(20 + TOUCH_END_STALE_MS - 1)).not.toBe(0);
  });

  it('イベント間隔が不均一でもウィンドウ全体の平均速度に近い値が出る', () => {
    const tracker = new VelocityTracker();
    // 8ms/24ms を交互に混ぜつつ、position は timeStamp と同一（速度1px/msで一定）
    const timestamps = [0, 8, 32, 40, 64, 72, 96];
    for (const t of timestamps) {
      tracker.add(t, t);
    }

    expect(tracker.velocityAt(96)).toBeCloseTo(1, 10);
  });

  it('reset でサンプルがクリアされる', () => {
    const tracker = new VelocityTracker();
    tracker.add(0, 0);
    tracker.add(10, 16);
    tracker.reset();

    expect(tracker.velocityAt(16)).toBe(0);
  });

  it('序盤ゆっくり→終盤加速のサンプル列で、直近スパン(VELOCITY_RECENT_SPAN_MS)の速度を返す（ウィンドウ全体平均より高い）', () => {
    const tracker = new VelocityTracker();
    // 序盤: ウィンドウ(VELOCITY_WINDOW_MS=100ms)内でゆっくり移動(9px/90ms)
    const slowPhaseTimestamp = VELOCITY_WINDOW_MS - 10;
    expect(slowPhaseTimestamp).toBeLessThan(VELOCITY_WINDOW_MS);
    tracker.add(0, 0);
    tracker.add(9, slowPhaseTimestamp);
    // 終盤: 直近スパン(VELOCITY_RECENT_SPAN_MS=50ms)以内で急加速(4px/5ms x2)
    tracker.add(13, slowPhaseTimestamp + 5);
    tracker.add(17, slowPhaseTimestamp + 10);
    expect(slowPhaseTimestamp + 10 - slowPhaseTimestamp).toBeLessThanOrEqual(VELOCITY_RECENT_SPAN_MS);

    const lastTimestamp = slowPhaseTimestamp + 10;
    const wholeWindowAverage = (17 - 0) / (lastTimestamp - 0);
    const recentSpanVelocity = (17 - 9) / (lastTimestamp - slowPhaseTimestamp);

    // ウィンドウ全体(最古〜最新)の平均だと終盤の加速が薄まってしまうが、
    // 直近スパンのみを見ることでリリース直前の実速度(より速い値)を捉える
    expect(tracker.velocityAt(lastTimestamp)).toBeCloseTo(recentSpanVelocity, 10);
    expect(tracker.velocityAt(lastTimestamp)).toBeGreaterThan(wholeWindowAverage);
  });

  it('最終 move から 90ms 後(TOUCH_END_STALE_MS=100 未満)の touchend でも速度が0にならない', () => {
    const tracker = new VelocityTracker();
    tracker.add(0, 0);
    tracker.add(10, 20);

    const staleGapMs = 90;
    expect(staleGapMs).toBeLessThan(TOUCH_END_STALE_MS); // 前提: 従来の80msなら stale 扱いだった間隔
    expect(tracker.velocityAt(20 + staleGapMs)).not.toBe(0);
  });
});

describe('DeltaAccumulator', () => {
  it('add した合計が take で全量出る。take 後 pending は 0', () => {
    const acc = new DeltaAccumulator();
    acc.add(3);
    acc.add(4.5);

    expect(acc.take()).toBeCloseTo(7.5, 10);
    expect(acc.pending).toBe(0);
  });

  it('maxAbs cap 超過分が失われず次の take で出てくる（正・負両方向）', () => {
    const positive = new DeltaAccumulator();
    positive.add(10);
    expect(positive.take(4)).toBe(4);
    expect(positive.pending).toBeCloseTo(6, 10);
    expect(positive.take()).toBeCloseTo(6, 10);
    expect(positive.pending).toBe(0);

    const negative = new DeltaAccumulator();
    negative.add(-10);
    expect(negative.take(4)).toBe(-4);
    expect(negative.pending).toBeCloseTo(-6, 10);
    expect(negative.take()).toBeCloseTo(-6, 10);
    expect(negative.pending).toBe(0);
  });

  it('小数 px の蓄積が失われない', () => {
    const acc = new DeltaAccumulator();
    acc.add(0.1);
    acc.add(0.2);

    expect(acc.take()).toBeCloseTo(0.3, 10);
  });

  it('reset で蓄積がクリアされる', () => {
    const acc = new DeltaAccumulator();
    acc.add(5);
    acc.reset();

    expect(acc.pending).toBe(0);
    expect(acc.take()).toBe(0);
  });
});

describe('decayVelocity', () => {
  it('分割不変性: decayVelocity(v, a+b) ≒ decayVelocity(decayVelocity(v,a), b)（60Hz/120Hz刻みで一致）', () => {
    const initialVelocity = 10;
    const totalElapsed = 500;

    const direct = decayVelocity(initialVelocity, totalElapsed);

    // 60Hz 刻み(16.666...ms)を60回で累積減衰（ちょうど totalElapsed 分になる回数固定）
    const frame60 = totalElapsed / 60;
    let stepped60 = initialVelocity;
    for (let i = 0; i < 60; i++) {
      stepped60 = decayVelocity(stepped60, frame60);
    }

    // 120Hz 刻み(8.333...ms)を120回で累積減衰
    const frame120 = totalElapsed / 120;
    let stepped120 = initialVelocity;
    for (let i = 0; i < 120; i++) {
      stepped120 = decayVelocity(stepped120, frame120);
    }

    expect(stepped60).toBeCloseTo(direct, 6);
    expect(stepped120).toBeCloseTo(direct, 6);
    expect(stepped60).toBeCloseTo(stepped120, 6);
  });

  it('INERTIA_HALF_LIFE_MS 経過でちょうど半分になる', () => {
    expect(decayVelocity(10, INERTIA_HALF_LIFE_MS)).toBeCloseTo(5, 10);
  });
});
