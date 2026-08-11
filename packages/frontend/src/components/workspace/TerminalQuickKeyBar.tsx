import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { QuickActionButtons, type QuickActionButton } from '../ui/QuickActionButtons';
import { TerminalChatToggle, type WindowViewMode } from '../ui/TerminalChatToggle';
import { KEYBOARD_HEIGHT_THRESHOLD } from '../../hooks/useVirtualKeyboard';

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
  /** SP 端末⇄チャットのミニトグル（Issue #69 S8）。バー左端、⌨ の前に描画する。渡された場合
   * のみ描画する（省略時は出さない）。 */
  viewMode?: WindowViewMode;
  onChangeViewMode?: (mode: WindowViewMode) => void;
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
export function TerminalQuickKeyBar({ onSendKey, keyboardOpen, onToggleKeyboard, onOpenTabSwitcher, viewMode, onChangeViewMode }: TerminalQuickKeyBarProps) {
  const { t } = useTranslation('common');

  // ソフトキーボード追従（Issue #338 T9 #4）。このバーは通常、TerminalContainer の flex 末尾
  // に画面下端固定として置かれているだけ（position: fixed ではない）— ソフトキーボードが開くと
  // visualViewport は縮むがレイアウトビューポート（100dvh 等）は縮まないブラウザが多く、この
  // バーはキーボードの裏に隠れてしまう。旧 XTermView（削除済み、Issue #69 T3 以前）が端末本体の
  // 高さをこの同じ visualViewport resize/scroll 監視で追従させていたのと同じ手法を、今度は
  // バー自身の位置に適用する: キーボード出現中（shrink >= KEYBOARD_HEIGHT_THRESHOLD）は
  // position: fixed に切り替え、bottom を「レイアウトビューポート下端から visualViewport 下端
  // までの距離」（≈ キーボード高）に設定してキーボード直上に浮かせる。閉じたら通常の
  // 画面下端固定（in-flow）に戻す。resize/scroll はキーボード開閉アニメーション中に連続発火
  // するため、XTermView と同じく最後のイベントから120ms後に1回だけ確定する。
  const [keyboardBottom, setKeyboardBottom] = useState<number | null>(null);
  useEffect(() => {
    if (!window.visualViewport) return undefined;
    const vp = window.visualViewport;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const applyViewport = () => {
      const shrink = window.innerHeight - vp.height;
      if (shrink >= KEYBOARD_HEIGHT_THRESHOLD) {
        setKeyboardBottom(Math.max(window.innerHeight - (vp.offsetTop + vp.height), 0));
      } else {
        setKeyboardBottom(null);
      }
    };

    const onResize = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(applyViewport, 120);
    };

    vp.addEventListener('resize', onResize);
    vp.addEventListener('scroll', onResize);
    // 一部ブラウザはキーボード収納時に visualViewport の resize を発火せず
    // window の resize しか飛ばさないため、フォールバックとして window resize も監視する
    window.addEventListener('resize', onResize);
    return () => {
      clearTimeout(debounceTimer);
      vp.removeEventListener('resize', onResize);
      vp.removeEventListener('scroll', onResize);
      window.removeEventListener('resize', onResize);
      setKeyboardBottom(null);
    };
  }, []);

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
        paddingBottom: keyboardBottom !== null ? 'var(--space-2)' : 'calc(var(--space-2) + env(safe-area-inset-bottom))',
        background: 'var(--bg-card)',
        ...(keyboardBottom !== null
          ? { position: 'fixed', left: 0, right: 0, bottom: keyboardBottom, zIndex: 60, boxShadow: 'var(--shadow-2)' }
          : null),
      }}
    >
      {viewMode !== undefined && onChangeViewMode && (
        <TerminalChatToggle value={viewMode} onChange={onChangeViewMode} />
      )}

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
