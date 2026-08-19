// Tooltip.tsx の純ロジック部分を切り出したもの（レビュー指摘対応）。コンポーネント本体は
// jsdom なしでテストできる現状のテスト構成（vitest environment: 'node', *.test.ts のみ）に
// 合わせ、ビューポートクランプ計算と hover/focus の開閉状態遷移をここへ抽出している。

/**
 * クランプ計算に必要な実測値。**すべて「未補正・下側配置」の正準幾何**（前回の shiftX /
 * flipToTop による transform や配置切り替えの影響を受けない値）で渡すこと。
 *
 * - `wrapper*` は `wrapperEl.getBoundingClientRect()`（wrapper 自身には transform を
 *   当てていないので安全）。
 * - `tooltipWidth` / `tooltipHeight` は `tooltipEl.offsetWidth` / `offsetHeight`
 *   （CSS transform の影響を受けないレイアウト寸法。`getBoundingClientRect()` は
 *   transform 後・前回の上下反転後の矩形を返すため使わないこと — 再オープンやリサイズの
 *   たびに補正が発散する原因になる）。
 */
export interface TooltipClampInput {
  /** トリガー（wrapper）要素の左端。 */
  wrapperLeft: number;
  /** トリガー（wrapper）要素の右端。 */
  wrapperRight: number;
  /** トリガー（wrapper）要素の上端。上側反転時、そこに収まるかの判定に使う。 */
  wrapperTop: number;
  /** トリガー（wrapper）要素の下端。下側配置の基準に使う。 */
  wrapperBottom: number;
  /** ツールチップの幅（`offsetWidth`）。 */
  tooltipWidth: number;
  /** ツールチップの高さ（`offsetHeight`）。上側反転時の再配置にも使う。 */
  tooltipHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  /**
   * 可視領域（`window.visualViewport`）のレイアウトビューポート内での左オフセット。
   * ピンチズーム時などに `visualViewport.offsetLeft` を渡す。未対応環境・非ズーム時は 0。
   */
  viewportOffsetLeft?: number;
  /** 可視領域の上オフセット（`visualViewport.offsetTop` 相当）。未対応環境・非ズーム時は 0。 */
  viewportOffsetTop?: number;
  /** ビューポート端からの最小マージン。デフォルト 8px。 */
  margin?: number;
  /** トリガーとツールチップの間隔。CSS の `calc(100% + Npx)` と一致させる。デフォルト 8px。 */
  gap?: number;
}

export interface TooltipClampResult {
  /** `translate(-50%)` に対する追加の水平オフセット（px）。左右に収まっていれば 0。 */
  shiftX: number;
  /** true なら下側ではなく上側（トリガーの上）に配置する。 */
  flipToTop: boolean;
  /** `position: fixed` の `top` にそのまま渡す絶対値（ビューポート基準、margin 内にクランプ済み）。 */
  top: number;
  /**
   * 上下どちらにも収まりきらない場合のみ設定される高さ上限（px）。呼び出し側は
   * `maxHeight` + `overflowY: 'auto'` を適用する。`null` なら上限なし（そのままの高さで収まる）。
   */
  maxHeight: number | null;
}

const DEFAULT_MARGIN = 8;
const DEFAULT_GAP = 8;

/**
 * トリガー中央基準（`left:50%` + `translate(-50%)`）・下側配置を起点に、画面端で見切れない
 * よう水平方向の補正オフセットと、下に入りきらない場合の上側反転可否を計算する純関数。
 *
 * 反転は「上に置いても収まる」場合のみ行う。上下どちらにも収まらない場合は、**利用可能
 * スペースが大きい側**を選び、`top` をビューポート内（margin 分の余白を確保）にクランプし、
 * 選んだ側の利用可能スペースを `maxHeight` として返す（呼び出し側で `overflowY: 'auto'` を
 * 適用してスクロール可能にする救済 — 低い分割ペイン・横向きモバイル・高倍率ズームで実際に
 * 発生するケース）。
 *
 * 入力は必ず「未補正・下側配置」の正準幾何（`wrapperEl.getBoundingClientRect()` +
 * `tooltipEl.offsetWidth/offsetHeight`）で渡すこと。前回のクランプ結果（shiftX 適用後の
 * transform や flipToTop 適用後の配置）を入力に混ぜると、再オープンやリサイズのたびに
 * 補正がずれていく（レビュー指摘: 補正の発散）。同じ入力に対しては常に同じ出力を返す
 * （冪等）— `tooltipLogic.test.ts` 参照。
 */
export function computeTooltipClamp(input: TooltipClampInput): TooltipClampResult {
  const margin = input.margin ?? DEFAULT_MARGIN;
  const gap = input.gap ?? DEFAULT_GAP;
  const viewportOffsetLeft = input.viewportOffsetLeft ?? 0;
  const viewportOffsetTop = input.viewportOffsetTop ?? 0;

  const wrapperCenterX = (input.wrapperLeft + input.wrapperRight) / 2;
  const centeredLeft = wrapperCenterX - input.tooltipWidth / 2;
  const centeredRight = centeredLeft + input.tooltipWidth;

  const minLeft = viewportOffsetLeft + margin;
  const maxRight = viewportOffsetLeft + input.viewportWidth - margin;

  let shiftX = 0;
  if (centeredLeft < minLeft) {
    shiftX = minLeft - centeredLeft;
  } else if (centeredRight > maxRight) {
    shiftX = maxRight - centeredRight;
  }

  const minTop = viewportOffsetTop + margin;
  const maxBottom = viewportOffsetTop + input.viewportHeight - margin;

  const belowSpace = maxBottom - gap - input.wrapperBottom;
  const aboveSpace = input.wrapperTop - gap - minTop;

  const fitsBelow = input.tooltipHeight <= belowSpace;
  const fitsAbove = input.tooltipHeight <= aboveSpace;

  let flipToTop: boolean;
  let top: number;
  let maxHeight: number | null;

  if (fitsBelow) {
    flipToTop = false;
    top = input.wrapperBottom + gap;
    maxHeight = null;
  } else if (fitsAbove) {
    flipToTop = true;
    top = input.wrapperTop - gap - input.tooltipHeight;
    maxHeight = null;
  } else {
    // どちらにも収まらない: 利用可能スペースが大きい側を選び、その中に収める（スクロール救済）。
    flipToTop = aboveSpace > belowSpace;
    if (flipToTop) {
      top = minTop;
      maxHeight = Math.max(0, aboveSpace);
    } else {
      top = input.wrapperBottom + gap;
      maxHeight = Math.max(0, belowSpace);
    }
  }

  return { shiftX, flipToTop, top, maxHeight };
}

/** hover/focus/Esc による開閉状態。hover と focus は独立して保持する（レビュー指摘 #2）。 */
export interface TooltipVisibilityState {
  hovered: boolean;
  focused: boolean;
  /** Esc で明示的に閉じたかどうか。次の mouseenter/focus で解除される。 */
  dismissed: boolean;
}

export type TooltipVisibilityAction =
  | { type: 'mouseenter' }
  | { type: 'mouseleave' }
  | { type: 'focus' }
  | { type: 'blur' }
  | { type: 'escape' };

export const initialTooltipVisibilityState: TooltipVisibilityState = {
  hovered: false,
  focused: false,
  dismissed: false,
};

/**
 * hover と focus を独立した状態として扱う reducer。Esc は `dismissed` を立てて閉じるが、
 * 次に mouseenter か focus が発生した時点で解除する（Esc 後に残っていた hover/focus が
 * そのまま再表示のトリガーになることはないが、次の新しい操作では表示される）。
 */
export function tooltipVisibilityReducer(
  state: TooltipVisibilityState,
  action: TooltipVisibilityAction,
): TooltipVisibilityState {
  switch (action.type) {
    case 'mouseenter':
      return { ...state, hovered: true, dismissed: false };
    case 'mouseleave':
      return { ...state, hovered: false };
    case 'focus':
      return { ...state, focused: true, dismissed: false };
    case 'blur':
      return { ...state, focused: false };
    case 'escape':
      return { ...state, dismissed: true };
    default:
      return state;
  }
}

export function isTooltipOpen(state: TooltipVisibilityState): boolean {
  return !state.dismissed && (state.hovered || state.focused);
}
