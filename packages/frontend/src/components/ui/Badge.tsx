import type { CSSProperties } from 'react';

export type BadgeTone = 'neutral' | 'accent' | 'green' | 'orange' | 'purple' | 'red';

const TONE_COLORS: Record<BadgeTone, { color: string; bg: string; border: string }> = {
  neutral: { color: 'var(--text-dim)', bg: 'var(--bg)', border: 'var(--border)' },
  accent:  { color: 'var(--accent)',  bg: 'var(--accent-a08)',  border: 'var(--accent-a35)' },
  green:   { color: 'var(--success)',   bg: 'var(--success-a08)',   border: 'var(--success-a35)' },
  orange:  { color: 'var(--warning)',  bg: 'var(--warning-a08)',  border: 'var(--warning-a35)' },
  purple:  { color: 'var(--purple)',  bg: 'var(--purple-a08)',  border: 'var(--purple-a35)' },
  red:     { color: 'var(--danger)',     bg: 'var(--danger-a08)',     border: 'var(--danger-a35)' },
};

interface BadgeProps {
  children: React.ReactNode;
  tone?: BadgeTone;
  style?: CSSProperties;
}

export function Badge({ children, tone = 'neutral', style }: BadgeProps) {
  const t = TONE_COLORS[tone];
  return (
    <span
      style={{
        fontSize: 'var(--font-xs)',
        fontWeight: 500,
        color: t.color,
        background: t.bg,
        border: `1px solid ${t.border}`,
        borderRadius: 'var(--radius-sm)',
        padding: '2px 8px',
        lineHeight: 1.5,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </span>
  );
}
