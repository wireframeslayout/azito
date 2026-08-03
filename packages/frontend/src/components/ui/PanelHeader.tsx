import React from 'react';

interface PanelHeaderProps {
  title: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  /** Overrides for the header container (e.g. mobile padding/minHeight adjustments). */
  style?: React.CSSProperties;
}

export function PanelHeader({ title, icon, actions, style }: PanelHeaderProps) {
  return (
    <div className="ws-surface" style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      minHeight: 48, padding: '0 var(--space-4)',
      borderBottom: '1px solid var(--border)',
      background: 'var(--ws-surface-card)', flexShrink: 0,
      ...style,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-base)', fontWeight: 600, flex: 1, minWidth: 0 }}>
        {icon}{title}
      </div>
      {actions && <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>{actions}</div>}
    </div>
  );
}
