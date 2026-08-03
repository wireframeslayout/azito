/**
 * タッチスクロールの物理計算（速度推定・時間ベース慣性減衰・移動量アキュムレータ）。
 * DOM API に依存しない純粋モジュール。useTmuxTouchScroll から利用される想定。
 */

/** 速度推定に使うサンプルウィンドウ(ms)。古いサンプルの破棄用（速度計算そのものには使わない） */
export const VELOCITY_WINDOW_MS = 100;
/**
 * リリース速度推定に使う直近スパン(ms)。フリック終盤に加速する典型的な操作で、
 * ウィンドウ全体(VELOCITY_WINDOW_MS)の平均を取るとリリース時の実速度を過小評価するため、
 * 直近のこの区間のみで速度を計算する
 */
export const VELOCITY_RECENT_SPAN_MS = 50;
/**
 * これ以上古い最終 move では慣性を開始しない(ms)。iOS は指を離す際に touchend が
 * 最後の touchmove から遅れて届きやすいため、余裕を持たせた値にしている
 */
export const TOUCH_END_STALE_MS = 100;
/**
 * 慣性減衰の半減期(ms)。実効時定数 τ = HALF_LIFE / ln(2) ≈ 460ms が
 * iOS ネイティブスクロールの減衰(τ≈500ms 程度)に近くなるよう調整した値
 */
export const INERTIA_HALF_LIFE_MS = 320;
/** これ未満(px/ms)で慣性を停止する。早期打ち切りを避けるため小さめに設定 */
export const INERTIA_MIN_VELOCITY = 0.02;

interface VelocitySample {
  position: number;
  timeStamp: number;
}

/** 直近ウィンドウ内の move サンプルから速度(px/ms)を推定する */
export class VelocityTracker {
  private samples: VelocitySample[] = [];

  /** touchmove ごとに位置とイベント timeStamp を記録。ウィンドウより古いサンプルは破棄する */
  add(position: number, timeStamp: number): void {
    this.samples.push({ position, timeStamp });
    while (
      this.samples.length > 1 &&
      timeStamp - this.samples[0].timeStamp > VELOCITY_WINDOW_MS
    ) {
      this.samples.shift();
    }
  }

  /**
   * timeStamp 時点の速度(px/ms)。以下の場合は 0 を返す:
   * - サンプルが2個未満
   * - 最後のサンプルが timeStamp より TOUCH_END_STALE_MS 以上古い（指を止めてから離した）
   * 最新サンプルから遡って VELOCITY_RECENT_SPAN_MS 以内にある最古のサンプルを基準点にし、
   * そこから最新サンプルまでの差分で計算する（フリック終盤の加速をリリース速度として
   * 捉えるため、ウィンドウ全体(VELOCITY_WINDOW_MS)の平均ではなく直近スパンのみを見る）。
   * 該当する基準点候補がなければ最新の1つ前のサンプルを使う（最低2サンプルは確保する）。
   */
  velocityAt(timeStamp: number): number {
    if (this.samples.length < 2) {
      return 0;
    }
    const last = this.samples[this.samples.length - 1];
    if (timeStamp - last.timeStamp >= TOUCH_END_STALE_MS) {
      return 0;
    }
    let baseIndex = this.samples.length - 2;
    for (let i = 0; i < this.samples.length - 1; i++) {
      if (last.timeStamp - this.samples[i].timeStamp <= VELOCITY_RECENT_SPAN_MS) {
        baseIndex = i;
        break;
      }
    }
    const base = this.samples[baseIndex];
    const elapsed = last.timeStamp - base.timeStamp;
    if (elapsed <= 0) {
      return 0;
    }
    return (last.position - base.position) / elapsed;
  }

  reset(): void {
    this.samples = [];
  }
}

/** px 単位の移動量を蓄積し、フラッシュ時に取り出す。端数や cap 超過分は保持し続ける */
export class DeltaAccumulator {
  private accumulated = 0;

  add(delta: number): void {
    this.accumulated += delta;
  }

  /** 蓄積値を返して 0 にリセットする。maxAbs 指定時は絶対値で cap し、超過分は蓄積に残す */
  take(maxAbs?: number): number {
    if (maxAbs === undefined) {
      const value = this.accumulated;
      this.accumulated = 0;
      return value;
    }
    const sign = Math.sign(this.accumulated);
    const cappedAbs = Math.min(Math.abs(this.accumulated), maxAbs);
    const taken = sign * cappedAbs;
    this.accumulated -= taken;
    return taken;
  }

  get pending(): number {
    return this.accumulated;
  }

  reset(): void {
    this.accumulated = 0;
  }
}

/** 経過時間ベースの指数減衰。フレームレート非依存（分割しても合成結果が一致する） */
export function decayVelocity(velocity: number, elapsedMs: number): number {
  const decayFactor = 0.5 ** (elapsedMs / INERTIA_HALF_LIFE_MS);
  return velocity * decayFactor;
}
