import React from 'react';
import { Icon } from '../../ui/Icon';

interface ObjectSectionProps {
  id: string;
  label: string;
  count: number;
  collapsed: boolean;
  onToggleCollapse: () => void;
  action?: React.ReactNode;
  children: React.ReactNode;
  empty?: React.ReactNode;
}

export default function ObjectSection({
  label,
  count,
  collapsed,
  onToggleCollapse,
  action,
  children,
  empty,
}: ObjectSectionProps) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '8px 12px 4px', gap: 4 }}>
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-dim)',
            fontSize: 'var(--font-xs)',
            fontWeight: 600,
            letterSpacing: 0.3,
            padding: 0,
            textAlign: 'left',
          }}
        >
          <Icon name="chevron-right" size={14} rotate={collapsed ? 0 : 90} />
          <span>{label}</span>
          <span
            style={{
              fontWeight: 400,
              fontSize: 'var(--font-2xs)',
              background: 'var(--bg)',
              padding: '1px 6px',
              borderRadius: 'var(--radius-md)',
            }}
          >
            {count}
          </span>
        </button>
        {action}
      </div>
      {!collapsed && count > 0 && children}
      {!collapsed && count === 0 && empty}
    </div>
  );
}
