// SP文脈フッター高のオーナー登録レジストリ（Issue #69 T2/T3、Issue #338 T1で所有権管理化）。
// TerminalQuickKeyBar・チャット入力バー（PromptInputBar）は、自分が実際に描画されている間だけ
// 自分の高さを claimFooterHeight で公開し、非表示になったら releaseFooterHeight で解放する。
// F2稼働ステータスピル（FloatingActivityPill）はこの CSS変数を bottom オフセットとして参照する。
//
// 旧実装は「最後に呼んだ値が有効」という単純な後勝ちだったが、React の effect はマウント
// ツリーの子から先に走る（bottom-up）ため、ビューモード切替の同一コミット内で
// 「子（PromptInputBar）が実測高を claim → 親（TerminalContainer）の showQuickKeyBar
// 分岐が 0px で上書き」というオーナーをまたいだレースが起きていた（TerminalContainer.tsx
// 側は表示状態が変わるたびに無条件で 0 を書き込んでいたため、直前に子が claim した値を
// 意図せず消してしまう）。
//
// 現在の実装ではオーナー名を1つだけ保持し、release は「自分が現在のオーナーである場合のみ」
// 0 に戻す。他オーナーが後から claim 済みなら release は no-op になり、他人の値を壊さない。
const SP_FOOTER_HEIGHT_VAR = '--sp-footer-h';

let currentOwner: string | null = null;

function applyHeight(value: string): void {
  document.documentElement.style.setProperty(SP_FOOTER_HEIGHT_VAR, value);
}

/**
 * フッターを実際に描画しているコンポーネント自身が呼ぶ。最後に claim したオーナーの値のみが
 * 有効になる（後勝ち）。`px` は border-box の実測高（px）。
 */
export function claimFooterHeight(owner: string, px: number): void {
  currentOwner = owner;
  applyHeight(`${px}px`);
}

/**
 * 自分（owner）が現在のオーナーである場合のみ 0 に戻す。既に別オーナーが claim 済みなら
 * no-op — アンマウント順序やeffectの実行順に依存せず、後から claim した値を保護する。
 */
export function releaseFooterHeight(owner: string): void {
  if (currentOwner !== owner) return;
  currentOwner = null;
  applyHeight('0px');
}

/** テスト専用: モジュール内部のオーナー状態をリセットする。 */
export function __resetFooterHeightOwnerForTest(): void {
  currentOwner = null;
}
