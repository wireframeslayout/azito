import { useEffect, useRef, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { QuickActionButtons, type QuickActionButton } from '../ui/QuickActionButtons';
import { claimFooterHeight, releaseFooterHeight } from '../../lib/spFooterHeight';

// SP文脈フッター高の公開オーナー名（lib/spFooterHeight.ts）。このバー自身が実測高を
// claim/release する（Issue #338 T1: 「フッターを実際に描画しているコンポーネント自身」
// だけが claim/release する方針に統一 — 以前は親 TerminalContainer が表示状態から
// 固定値を計算して代理で公開していたが、それだと PromptInputBar とのオーナーをまたいだ
// レースの温床になっていた）。
const FOOTER_HEIGHT_OWNER = 'quick-key-bar';

export interface TerminalQuickKeyBarProps {
  /** SPECIAL_KEY_MAP (XTermView) 準拠のキー名で送出する。Issue #69 T3 — 送出経路は
   *  XTermViewHandle.sendKey を呼び出し元（TerminalContainer）から渡してもらうだけで、
   *  ここでは新規の送出実装を持たない。 */
  onSendKey: (key: string) => void;
  /** ⌨ 透過パッド（MobileKeyboardOverlay）の開閉状態。トグルボタンの見た目に反映する。 */
  keyboardOpen: boolean;
  onToggleKeyboard: () => void;
  /** 右端 ▦ ボタン: タブスイッチャーを開く。 */
  onOpenTabSwitcher: () => void;
}

const KEY_STYLE: CSSProperties = {
  background: 'var(--input-bg)',
  border: 'none',
  color: 'var(--text-dim)',
  borderRadius: 'var(--radius-sm)',
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 'var(--font-2xs)',
  fontWeight: 500,
  height: 32,
  minWidth: 40,
  padding: '0 var(--space-2)',
};

const ICON_KEY_STYLE: CSSProperties = {
  ...KEY_STYLE,
  width: 32,
  minWidth: 32,
  padding: 0,
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const QUICK_KEYS: QuickActionButton[] = [
  { label: 'Esc', key: 'Escape', style: KEY_STYLE },
  { label: 'Tab', key: 'Tab', style: KEY_STYLE },
  { label: 'Ctrl+C', key: 'C-c', style: KEY_STYLE },
  { label: <Icon name="arrow-up" size={14} />, key: 'Up', style: KEY_STYLE },
  { label: <Icon name="arrow-down" size={14} />, key: 'Down', style: KEY_STYLE },
  { label: 'Enter', key: 'Enter', style: KEY_STYLE },
];

/**
 * SP端末クイックキーフッター（Issue #69 T3 / モック S6-15・S6-11）。SP・端末ビュー表示中の
 * みマウントされる下端固定バー。構成: ⌨（透過パッドトグル）｜ Esc/Tab/Ctrl+C/↑/↓/Enter
 * （横スクロール）｜右端 ▦（タブスイッチャー）。チャットビュー・概要/コミット/差分では
 * TerminalContainer 側がそもそもマウントしない。
 */
export function TerminalQuickKeyBar({ onSendKey, keyboardOpen, onToggleKeyboard, onOpenTabSwitcher }: TerminalQuickKeyBarProps) {
  const { t } = useTranslation('common');
  const barRef = useRef<HTMLDivElement>(null);

  // マウント中は実測高（safe-area 込みのボーダーボックス）を --sp-footer-h として公開し、
  // アンマウント時は自分がオーナーの場合のみ解放する。このバーは isMobile かつ端末ビューの
  // ときだけ TerminalContainer から条件付きマウントされるため、表示条件の判定はここでは行わない。
  useEffect(() => {
    const el = barRef.current;
    if (!el) return undefined;
    const observer = new ResizeObserver(() => {
      claimFooterHeight(FOOTER_HEIGHT_OWNER, el.getBoundingClientRect().height);
    });
    observer.observe(el);
    claimFooterHeight(FOOTER_HEIGHT_OWNER, el.getBoundingClientRect().height);
    return () => {
      observer.disconnect();
      releaseFooterHeight(FOOTER_HEIGHT_OWNER);
    };
  }, []);

  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label={t('terminal.quickKeyBar.ariaLabel')}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-1)',
        minHeight: 44,
        flexShrink: 0,
        padding: 'var(--space-2)',
        paddingBottom: 'calc(var(--space-2) + env(safe-area-inset-bottom))',
        background: 'var(--bg-card)',
      }}
    >
      <button
        type="button"
        onClick={onToggleKeyboard}
        aria-pressed={keyboardOpen}
        aria-label={t('terminal.quickKeyBar.keyboardToggle')}
        title={t('terminal.quickKeyBar.keyboardToggle')}
        style={{
          ...ICON_KEY_STYLE,
          background: keyboardOpen ? 'var(--accent-a15)' : ICON_KEY_STYLE.background,
          color: keyboardOpen ? 'var(--accent)' : ICON_KEY_STYLE.color,
        }}
      >
        <Icon name="keyboard" size={14} />
      </button>

      <div style={{ flex: 1, minWidth: 0, overflowX: 'auto', scrollbarWidth: 'none' }}>
        <QuickActionButtons buttons={QUICK_KEYS} onAction={onSendKey} />
      </div>

      <button
        type="button"
        onClick={onOpenTabSwitcher}
        aria-label={t('terminal.quickKeyBar.tabSwitcher')}
        title={t('terminal.quickKeyBar.tabSwitcher')}
        style={ICON_KEY_STYLE}
      >
        <Icon name="windows" size={14} />
      </button>
    </div>
  );
}
