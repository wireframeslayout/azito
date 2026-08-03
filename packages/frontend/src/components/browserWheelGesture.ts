// DOM 非依存の物理計算: BrowserView のタッチスクロール慣性（Issue #403）で使う
// 速度推定・指数減衰・慣性変位の計算。BrowserTouchGesture（タップ/スワイプ判定）
// とは責務が異なる（あちらは「タップか否か」の状態機械、こちらは「リリース後
// どれだけ・どの速さで動き続けるか」の連続的な物理量）ため、あえて別ファイル・
// 別クラスに分離している。
//
// task/224（ターミナルの touchScrollPhysics.ts）とは semantics が異なるため
// 統合していない（計画時点で合意済み）— ターミナルは行単位の離散スクロール、
// こちらはピクセル単位で 1:1 に追従するリモートページのスクロールで、丸め/
// 量子化の要件が異なる。ただし定数値（VELOCITY_RECENT_SPAN_MS/INERTIA_HALF_LIFE_MS
// 等）は iOS ネイティブのスクロール慣性感に近づける根拠が共通のため、task/224
// 側と同値に揃えてある。

// リリース速度推定に使う直近の時間幅。指を離す直前 50ms 程度の動きだけを見る
// ことで、フリックの瞬間的な加速を捉える（スワイプ全体の平均速度だと、ゆっくり
// 動かした後に素早くフリックした場合の「勢い」が薄まってしまう）。iOS の
// UIScrollView 相当のフリック感に近づけるための値。
export const VELOCITY_RECENT_SPAN_MS = 50;

// 速度推定用に保持するサンプル履歴の長さ。VELOCITY_RECENT_SPAN_MS より長く
// 保持しておき、直近スパンの起点となるサンプルを探索できるようにする。
export const VELOCITY_SAMPLE_WINDOW_MS = 100;

// touchend が最後の touchmove からこの時間以上経っていたら「すでに指が止まって
// から離した」とみなし、慣性を発生させない（速度 0 を返す）。指を置いたまま
// 静止してから離すケースで、古い移動サンプルに基づく慣性が意図せず走るのを防ぐ。
export const TOUCH_END_STALE_MS = 100;

// 慣性減衰の半減期（ms）。iOS ネイティブのスクロール慣性の減衰感に近い値として
// 経験的に調整済み（task/224 のターミナル側とも同値）。
export const INERTIA_HALF_LIFE_MS = 320;

// この大きさ（px/ms、2次元は速度ベクトルの大きさ = Math.hypot(vx, vy)）を
// 下回ったら慣性を打ち切る。ゼロに漸近するだけの微小フレームを無限に送り
// 続けないための閾値。
export const INERTIA_MIN_VELOCITY = 0.02;

// 半減期から指数減衰の時定数 τ を導出（v(t) = v0 * e^(-t/τ)、半減期 t = τ*ln2
// で v = v0/2 になる関係から τ = halfLife / ln2）。
const INERTIA_TAU_MS = INERTIA_HALF_LIFE_MS / Math.LN2;

interface VelocitySample {
  x: number;
  y: number;
  /** イベントの timeStamp（ms、DOMHighResTimeStamp 相当）。 */
  t: number;
}

export interface Velocity2D {
  vx: number;
  vy: number;
}

export interface Vector2D {
  x: number;
  y: number;
}

/**
 * touchmove ごとの位置・時刻サンプルを保持し、touchend 時点のリリース速度を
 * 推定する。直近 VELOCITY_RECENT_SPAN_MS の移動幅だけを見ることで、フリック
 * 動作の瞬間的な加速を捉える（詳細は上部コメント参照）。
 */
export class WheelVelocityTracker {
  private samples: VelocitySample[] = [];

  reset(): void {
    this.samples = [];
  }

  addSample(x: number, y: number, t: number): void {
    this.samples.push({ x, y, t });
    // VELOCITY_SAMPLE_WINDOW_MS より古いサンプルは以後の推定に不要なので捨てる
    // （直近スパンの起点探索さえできれば十分なため、最後の1件は必ず残す）。
    const cutoff = t - VELOCITY_SAMPLE_WINDOW_MS;
    while (this.samples.length > 1 && this.samples[0].t < cutoff) {
      this.samples.shift();
    }
  }

  /**
   * touchend の timeStamp（endT）時点のリリース速度を推定する。最後の
   * touchmove サンプルから TOUCH_END_STALE_MS 以上経っていれば（指を静止させて
   * から離した）速度 0 を返す。サンプルが無ければ同様に 0。
   */
  releaseVelocity(endT: number): Velocity2D {
    if (this.samples.length === 0) return { vx: 0, vy: 0 };
    const last = this.samples[this.samples.length - 1];
    if (endT - last.t > TOUCH_END_STALE_MS) return { vx: 0, vy: 0 };
    if (this.samples.length < 2) return { vx: 0, vy: 0 };

    // 直近 VELOCITY_RECENT_SPAN_MS 以内で最も古いサンプル（last 自身を除く）を
    // 起点に取る。samples は追加順（時系列昇順）なので、最初に条件を満たした
    // ものが最古。該当が無い場合（直近スパン内に last 以外のサンプルが1つも
    // 無い＝サンプル間隔がスパンより疎な場合）は、last 自身を起点にして dt=0 に
    // なってしまう（＝速度0になる）のを避けるため、直近の1つ前のサンプルへ
    // フォールバックする（task/224 のターミナル側と同じフォールバック）。
    const priorSamples = this.samples.slice(0, -1);
    const cutoff = last.t - VELOCITY_RECENT_SPAN_MS;
    let base = priorSamples[priorSamples.length - 1];
    for (const sample of priorSamples) {
      if (sample.t >= cutoff) {
        base = sample;
        break;
      }
    }

    const dt = last.t - base.t;
    if (dt <= 0) return { vx: 0, vy: 0 };
    return {
      vx: (last.x - base.x) / dt,
      vy: (last.y - base.y) / dt,
    };
  }
}

/** 半減期 INERTIA_HALF_LIFE_MS の指数減衰: 初速 v0 から elapsedMs 後の速度。 */
export function decayVelocity(v0: number, elapsedMs: number): number {
  return v0 * Math.exp(-elapsedMs / INERTIA_TAU_MS);
}

/**
 * 指数減衰する速度を、長さ dtMs のフレーム区間にわたって解析的に積分した変位。
 * `velocityAtFrameStart` はそのフレーム開始時点での（すでに decayVelocity で
 * 減衰済みの）速度。
 *
 * ∫[0,dt] v0*e^(-(t0+s)/τ) ds = v(t0) * τ * (1 - e^(-dt/τ)) という閉形式を使う
 * ことで、v * dt のオイラー近似と違い、フレームが遅延して dt が大きくなっても
 * 過大な変位にならない（真の積分値と一致する）。
 */
export function inertiaDisplacement(velocityAtFrameStart: number, dtMs: number): number {
  if (dtMs <= 0) return 0;
  return velocityAtFrameStart * INERTIA_TAU_MS * (1 - Math.exp(-dtMs / INERTIA_TAU_MS));
}

/**
 * 2次元の慣性スクロールを rAF ループで駆動するための状態。BrowserView は
 * タップ確定を経ずスワイプで touchend した際、WheelVelocityTracker.releaseVelocity()
 * の結果でこれを構築し、`done` が true になるまで毎フレーム `step(dt)` を呼んで
 * 得た変位を mouseWheel として送る。
 */
export class BrowserWheelInertia {
  private elapsedMs = 0;

  constructor(private readonly vx0: number, private readonly vy0: number) {}

  /** 現在の（減衰後の）速度ベクトルの大きさが閾値を下回ったら慣性終了。 */
  get done(): boolean {
    const vx = decayVelocity(this.vx0, this.elapsedMs);
    const vy = decayVelocity(this.vy0, this.elapsedMs);
    return Math.hypot(vx, vy) < INERTIA_MIN_VELOCITY;
  }

  /** dtMs 経過分だけ進め、その区間で解析積分した変位を返す。 */
  step(dtMs: number): Vector2D {
    const vxAtStart = decayVelocity(this.vx0, this.elapsedMs);
    const vyAtStart = decayVelocity(this.vy0, this.elapsedMs);
    const dx = inertiaDisplacement(vxAtStart, dtMs);
    const dy = inertiaDisplacement(vyAtStart, dtMs);
    this.elapsedMs += dtMs;
    return { x: dx, y: dy };
  }
}
