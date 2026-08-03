import type { CSSProperties } from 'react';

export type ChipTone = 'default' | 'red' | 'purple' | 'green' | 'orange' | 'accent';

const TONE_STYLES: Record<ChipTone, CSSProperties> = {
  default: {
    color: 'var(--text-dim)',
    background: 'var(--bg)',
    border: '1px solid var(--border)',
  },
  red: {
    color: 'var(--danger)',
    background: 'var(--danger-a08)',
    border: '1px solid var(--danger-a35)',
  },
  purple: {
    color: 'var(--purple)',
    background: 'var(--purple-a08)',
    border: '1px solid var(--purple-a35)',
  },
  green: {
    color: 'var(--success)',
    background: 'var(--success-a08)',
    border: '1px solid var(--success-a35)',
  },
  orange: {
    color: 'var(--warning)',
    background: 'var(--warning-a08)',
    border: '1px solid var(--warning-a35)',
  },
  accent: {
    color: 'var(--accent)',
    background: 'var(--accent-a08)',
    border: '1px solid var(--accent-a35)',
  },
};

interface ChipProps {
  children: React.ReactNode;
  tone?: ChipTone;
  /** 長いテキスト（パス等）用。指定時は overflow hidden + ellipsis で切り詰める。 */
  maxWidth?: number;
  style?: CSSProperties;
}

/**
 * Dense Rows（Issue #274 案B）の行右側に並べる pill 型の小さなメタ情報表示。
 * 既存の Badge（角丸4pxの矩形バッジ）とは形状・配色の指定が異なるため別コンポーネントとして用意する。
 */
export function Chip({ children, tone = 'default', maxWidth, style }: ChipProps) {
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: 'var(--font-xs)',
        fontWeight: 500,
        lineHeight: 1.5,
        padding: '1px 7px',
        borderRadius: 'var(--radius-full)',
        whiteSpace: 'nowrap',
        fontVariantNumeric: 'tabular-nums',
        ...TONE_STYLES[tone],
        ...(maxWidth !== undefined
          ? { maxWidth, overflow: 'hidden', textOverflow: 'ellipsis', verticalAlign: 'bottom' }
          : undefined),
        ...style,
      }}
    >
      {children}
    </span>
  );
}
