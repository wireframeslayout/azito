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
}

const DEFAULT_MARGIN = 8;
const DEFAULT_GAP = 8;

/** `computeTooltipClamp` の既定 gap（px）。呼び出し側で `top`/`bottom` の絶対座標を
 * 組み立てる際、CSS の `calc(100% + Npx)` と同じ値を使うためにエクスポートする。 */
export { DEFAULT_GAP as TOOLTIP_GAP };

/**
 * トリガー中央基準（`left:50%` + `translate(-50%)`）・下側配置を起点に、画面端で見切れない
 * よう水平方向の補正オフセットと、下に入りきらない場合の上側反転可否を計算する純関数。
 *
 * 反転は「上に置いても収まる」場合のみ行う。上下どちらにも収まらない極小ビューポートでは、
 * 反転せず下側配置のまま返す（それ以上の救済はスクロール等の別対応に委ねる）。
 *
 * 入力は必ず「未補正・下側配置」の正準幾何（`wrapperEl.getBoundingClientRect()` +
 * `tooltipEl.offsetWidth/offsetHeight`）で渡すこと。前回のクランプ結果（shiftX 適用後の
 * transform や flipToTop 適用後の配置）を入力に混ぜると、再オープンやリサイズのたびに
 * 補正がずれていく（レビュー指摘: 補正の発散）。同じ入力に対しては常に同じ出力を返す
 * （冪等）— `tooltipLogic.test.ts` の "idempotence" テスト参照。
 */
export function computeTooltipClamp(input: TooltipClampInput): TooltipClampResult {
  const margin = input.margin ?? DEFAULT_MARGIN;
  const gap = input.gap ?? DEFAULT_GAP;

  const wrapperCenterX = (input.wrapperLeft + input.wrapperRight) / 2;
  const centeredLeft = wrapperCenterX - input.tooltipWidth / 2;
  const centeredRight = centeredLeft + input.tooltipWidth;

  let shiftX = 0;
  if (centeredLeft < margin) {
    shiftX = margin - centeredLeft;
  } else if (centeredRight > input.viewportWidth - margin) {
    shiftX = input.viewportWidth - margin - centeredRight;
  }

  const belowBottom = input.wrapperBottom + gap + input.tooltipHeight;
  const aboveTop = input.wrapperTop - gap - input.tooltipHeight;

  const overflowsBottom = belowBottom > input.viewportHeight - margin;
  const fitsAbove = aboveTop >= margin;
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
