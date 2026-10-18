import type { KeyboardEvent } from 'react';
import { Icon, type IconName } from './Icon';
import { nextEnabledOption } from './segmentedToggleLogic';

export interface SegmentedToggleOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  /** この選択肢を選べない。理由は `disabledReason`（title と aria-describedby 用）で示す。 */
  disabled?: boolean;
  disabledReason?: string;
  /** `disabledReason` を画面上に出している要素の id（スクリーンリーダー向けに関連付ける）。 */
  describedBy?: string;
}

interface SegmentedToggleProps<T extends string> {
  options: SegmentedToggleOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  ariaLabel?: string;
  /** 全体を操作不可にする（読み込み中など）。 */
  disabled?: boolean;
}

/**
 * 2〜3択の面切替トグル（例: 端末⇄チャット）。タブ相当だが独立したビューを排他表示する用途向けに、
 * 面（--bg-hover の背景に選択セグメントを --bg-solid で載せる）で階層を作る。既存の下線タブ
 * （MiniTabBar）とは用途が異なる: あちらは複数タブの並列表示、こちらは同一領域の表示モード切替。
 * デザイン方針によりボーダーは使わない（--bg-* トークンのみで階層表現）。
 */
export function SegmentedToggle<T extends string>({ options, value, onChange, size = 'sm', ariaLabel, disabled = false }: SegmentedToggleProps<T>) {
  const padding = size === 'sm' ? 'var(--space-1) var(--space-2)' : 'var(--space-1) var(--space-3)';
  const fontSize = size === 'sm' ? 'var(--font-xs)' : 'var(--font-sm)';
  const iconSize = 14;

  // 左右キーで有効な隣の選択肢へ移る（tablist の標準操作）。
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const next = nextEnabledOption(options, value, e.key === 'ArrowRight' ? 1 : -1, disabled);
    if (!next) return;
    e.preventDefault();
    onChange(next.value);
    const buttons = e.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="tab"]');
    buttons[options.indexOf(next)]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      onKeyDown={handleKeyDown}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-1)',
        padding: 'var(--space-1)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--bg-hover)',
        flexShrink: 0,
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        const isDisabled = disabled || opt.disabled === true;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            className="segmented-toggle-btn"
            aria-selected={active}
            title={opt.disabled && opt.disabledReason ? `${opt.label}: ${opt.disabledReason}` : opt.label}
            disabled={isDisabled}
            aria-describedby={opt.disabled ? opt.describedBy : undefined}
            onClick={() => { if (!active) onChange(opt.value); }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-1)',
              padding,
              fontSize,
              fontWeight: active ? 600 : 400,
              fontFamily: 'inherit',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              background: active ? 'var(--bg-solid)' : 'transparent',
              color: active ? 'var(--text)' : 'var(--text-dim)',
              cursor: isDisabled ? 'not-allowed' : 'pointer',
              opacity: isDisabled && !active ? 0.5 : 1,
              whiteSpace: 'nowrap',
              transition: 'background 0.12s, color 0.12s',
            }}
          >
            {opt.icon && <Icon name={opt.icon} size={iconSize} />}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
