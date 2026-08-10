import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { QuickActionButtons, type QuickActionButton } from '../ui/QuickActionButtons';

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

  return (
    <div
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
