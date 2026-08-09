import { Icon, type IconName } from './Icon';

export interface SegmentedToggleOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
}

interface SegmentedToggleProps<T extends string> {
  options: SegmentedToggleOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  ariaLabel?: string;
}

/**
 * 2〜3択の面切替トグル（例: 端末⇄チャット）。タブ相当だが独立したビューを排他表示する用途向けに、
 * 面（--bg-hover の背景に選択セグメントを --bg-solid で載せる）で階層を作る。既存の下線タブ
 * （MiniTabBar）とは用途が異なる: あちらは複数タブの並列表示、こちらは同一領域の表示モード切替。
 * デザイン方針によりボーダーは使わない（--bg-* トークンのみで階層表現）。
 */
export function SegmentedToggle<T extends string>({ options, value, onChange, size = 'sm', ariaLabel }: SegmentedToggleProps<T>) {
  const padding = size === 'sm' ? '3px 8px' : '5px 12px';
  const fontSize = size === 'sm' ? 'var(--font-xs)' : 'var(--font-sm)';
  const iconSize = 14;

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        padding: 2,
        borderRadius: 'var(--radius-md)',
        background: 'var(--bg-hover)',
        flexShrink: 0,
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="tab"
            aria-selected={active}
            title={opt.label}
            onClick={() => { if (!active) onChange(opt.value); }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding,
              fontSize,
              fontWeight: active ? 600 : 400,
              fontFamily: 'inherit',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              background: active ? 'var(--bg-solid)' : 'transparent',
              color: active ? 'var(--text)' : 'var(--text-dim)',
              cursor: 'pointer',
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
