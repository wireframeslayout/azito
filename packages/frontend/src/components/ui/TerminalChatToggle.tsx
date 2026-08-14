import { useTranslation } from 'react-i18next';
import { Icon } from './Icon';

// 'terminal' | 'chat' — TerminalContainer.tsx の WindowViewMode と同一の値集合。ui/ は基盤層
// のため domain コンポーネント（TerminalContainer）から型を import せず、ここで独立定義する
// （依存方向: ui → 上位コンポーネントは禁止 / .dependency-cruiser.cjs）。呼び出し側で
// WindowViewMode 型とそのまま代入互換。
export type WindowViewMode = 'terminal' | 'chat';

export interface TerminalChatToggleProps {
  value: WindowViewMode;
  onChange: (mode: WindowViewMode) => void;
  /** Disables interaction without hiding the control (e.g. no window resolved yet). */
  disabled?: boolean;
}

/**
 * SP 端末⇄チャットのミニトグル（Issue #69 S8）— qbar/PromptInputBar の左端、および
 * タスク外の単体ウィンドウタブのツールバー下端で共有される最小altitude部品。承認済み
 * モック s78-00/01: --input-bg の台座に 2px padding、選択側だけ --bg-elevated を敷く。
 * 既存 SegmentedToggle（--bg-hover/--bg-solid 固定）はこのトークン組み合わせに合わないため、
 * アイコンのみ2択専用の軽量コンポーネントとして切り出す（複数箇所で再利用される前提の
 * props駆動コンポーネント）。
 */
export function TerminalChatToggle({ value, onChange, disabled }: TerminalChatToggleProps) {
  const { t } = useTranslation('common');
  const options: { mode: WindowViewMode; icon: 'terminal' | 'transcript'; label: string }[] = [
    { mode: 'terminal', icon: 'terminal', label: t('terminal.viewMode.terminal') },
    { mode: 'chat', icon: 'transcript', label: t('terminal.viewMode.chat') },
  ];

  return (
    <div
      role="tablist"
      aria-label={t('terminal.viewMode.ariaLabel')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        padding: 2,
        borderRadius: 'var(--radius-md)',
        background: 'var(--input-bg)',
        flexShrink: 0,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {options.map((opt) => {
        const active = value === opt.mode;
        return (
          <button
            key={opt.mode}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={opt.label}
            title={opt.label}
            disabled={disabled}
            // Always fires onChange, even when `value` already equals this option: callers
            // like TaskPanel's MobileContextFooter (non-window views, Issue #69 S8) use the
            // same toggle to *navigate back* to the window/chat content, where `value` reflects
            // the user's last terminal/chat preference rather than "currently displaying a
            // window" — so a click here must never be treated as a no-op just because the
            // preference already matches.
            onClick={() => { if (!disabled) onChange(opt.mode); }}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 30,
              height: 30,
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              background: active ? 'var(--bg-elevated)' : 'transparent',
              color: active ? 'var(--text)' : 'var(--text-dim)',
              cursor: disabled ? 'default' : 'pointer',
            }}
          >
            <Icon name={opt.icon} size={14} />
          </button>
        );
      })}
    </div>
  );
}
