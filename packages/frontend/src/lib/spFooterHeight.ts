// SP文脈フッター高の共有setter（Issue #69 T2/T3）。TerminalQuickKeyBar・チャット入力バー
// （PromptInputBar）・ホーム状態のみ表示される MobileMenuBar が、自分の表示中に自分の高さを
// このCSS変数へ公開する。F2稼働ステータスピル（FloatingActivityPill）はこれを bottom オフセット
// として参照する。3者は排他的に表示される（タブ有無・ビューモードで切り替わる）ため、
// 最後に呼ばれた値がそのまま有効な値になる — 独自に値を保持・調停するストアは持たない。
const SP_FOOTER_HEIGHT_VAR = '--sp-footer-h';

export function setSpFooterHeight(value: string | null): void {
  document.documentElement.style.setProperty(SP_FOOTER_HEIGHT_VAR, value ?? '0px');
}
