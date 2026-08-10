// SP文脈フッター高の共有setter（Issue #69 T2/T3）。TerminalQuickKeyBar・チャット入力バー
// （PromptInputBar）が、自分の表示中に自分の高さをこのCSS変数へ公開する。F2稼働ステータスピル
// （FloatingActivityPill）はこれを bottom オフセットとして参照する。両者は排他的に表示される
// （ビューモードで切り替わる）ため、最後に呼ばれた値がそのまま有効な値になる — 独自に値を
// 保持・調停するストアは持たない。旧 MobileMenuBar（ホーム状態専用の下部バー）はデッドコード
// として削除済み（Issue #69 T6）— 削除後はタブ未選択時 footer-h=0 でピルが最下部（safe-area上）
// に位置する。
const SP_FOOTER_HEIGHT_VAR = '--sp-footer-h';

export function setSpFooterHeight(value: string | null): void {
  document.documentElement.style.setProperty(SP_FOOTER_HEIGHT_VAR, value ?? '0px');
}
