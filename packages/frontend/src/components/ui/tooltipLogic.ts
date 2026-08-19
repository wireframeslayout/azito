// Tooltip.tsx の純ロジック部分を切り出したもの（レビュー指摘対応）。コンポーネント本体は
// jsdom なしでテストできる現状のテスト構成（vitest environment: 'node', *.test.ts のみ）に
// 合わせ、ビューポートクランプ計算と hover/focus の開閉状態遷移をここへ抽出している。

/** ビューポート内クランプ計算に必要な実測値。単位はすべて px（getBoundingClientRect 由来）。 */
export interface TooltipClampInput {
  /** クランプ前（`left: 50%; translate(-50%)`）のツールチップ左端。 */
  tooltipLeft: number;
  /** クランプ前のツールチップ右端。 */
  tooltipRight: number;
  /** クランプ前のツールチップ下端。 */
  tooltipBottom: number;
  /** ツールチップの高さ（上側反転時の再配置に使う）。 */
  tooltipHeight: number;
  /** トリガー要素の上端。上側反転時、そこに収まるかの判定に使う。 */
  triggerTop: number;
  viewportWidth: number;
  viewportHeight: number;
  /** ビューポート端からの最小マージン。デフォルト 8px。 */
  margin?: number;
}

export interface TooltipClampResult {
  /** `translate(-50%)` に対する追加の水平オフセット（px）。左右に収まっていれば 0。 */
  shiftX: number;
  /** true なら下側ではなく上側（トリガーの上）に配置する。 */
  flipToTop: boolean;
}

const DEFAULT_MARGIN = 8;

/**
 * トリガー中央基準（`left:50%` + `translate(-50%)`）で配置したツールチップが画面端で
 * 見切れないよう、水平方向の補正オフセットと、下に入りきらない場合の上側反転可否を計算する。
 *
 * 反転は「上に置いても収まる」場合のみ行う。上下どちらにも収まらない極小ビューポートでは、
 * 反転せず下側配置のまま返す（それ以上の救済はスクロール等の別対応に委ねる）。
 */
export function computeTooltipClamp(input: TooltipClampInput): TooltipClampResult {
  const margin = input.margin ?? DEFAULT_MARGIN;

  let shiftX = 0;
  if (input.tooltipLeft < margin) {
    shiftX = margin - input.tooltipLeft;
  } else if (input.tooltipRight > input.viewportWidth - margin) {
    shiftX = input.viewportWidth - margin - input.tooltipRight;
  }

  const overflowsBottom = input.tooltipBottom > input.viewportHeight - margin;
  const fitsAbove = input.triggerTop - input.tooltipHeight - margin >= margin;
  const flipToTop = overflowsBottom && fitsAbove;

  return { shiftX, flipToTop };
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
