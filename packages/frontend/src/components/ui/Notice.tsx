import type { CSSProperties, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export type NoticeTone = 'info' | 'success' | 'warning' | 'danger';

const TONE_MAP: Record<NoticeTone, { token: string; icon: IconName }> = {
  info:    { token: 'var(--accent)',  icon: 'info' },
  success: { token: 'var(--success)', icon: 'circle-check' },
  warning: { token: 'var(--warning)', icon: 'warning' },
  danger:  { token: 'var(--danger)',  icon: 'warning' },
};

interface NoticeProps {
  tone: NoticeTone;
  children: ReactNode;
  sub?: ReactNode;
  action?: ReactNode;
  style?: CSSProperties;
}

export function Notice({ tone, children, sub, action, style }: NoticeProps) {
  const { token, icon } = TONE_MAP[tone];
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '10px 12px',
        borderRadius: 'var(--radius-md)',
        background: `color-mix(in srgb, ${token} 7%, var(--bg-card))`,
        boxShadow: 'inset 0 1px 0 var(--edge-hi)',
        fontSize: 'var(--font-xs)',
        color: 'var(--text)',
        ...style,
      }}
    >
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 22,
          height: 22,
          borderRadius: 6,
          background: `color-mix(in srgb, ${token} 18%, transparent)`,
          color: token,
          flexShrink: 0,
        }}
      >
        <Icon name={icon} size={14} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {children}
        {sub != null && (
          <div style={{ color: 'var(--text-dim)', marginTop: 2 }}>{sub}</div>
        )}
        {action != null && (
          <div style={{ marginTop: 6 }}>{action}</div>
        )}
      </div>
    </div>
  );
}
