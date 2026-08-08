import type { ReactNode } from 'react';
import { Icon, type IconName } from '../ui/Icon';

interface CollapsibleBlockProps {
  icon: IconName;
  label: ReactNode;
  tone?: 'default' | 'danger';
  truncatedNote?: string;
  children: ReactNode;
}

/**
 * thinking / tool_use / tool_result 用の折りたたみブロック。既定閉。
 * ネイティブ <details>/<summary> を使い、キーボード操作・フォーカスを無償で得る。
 */
export function CollapsibleBlock({ icon, label, tone = 'default', truncatedNote, children }: CollapsibleBlockProps) {
  const color = tone === 'danger' ? 'var(--danger)' : 'var(--text-dim)';
  return (
    <details
      style={{
        margin: '6px 0',
        border: `1px solid ${tone === 'danger' ? 'var(--danger-a35)' : 'var(--border)'}`,
        borderRadius: 'var(--radius-sm)',
        background: tone === 'danger' ? 'var(--danger-a08)' : 'var(--bg)',
      }}
    >
      <summary
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 10px',
          cursor: 'pointer',
          fontSize: 'var(--font-xs)',
          fontWeight: 600,
          color,
          userSelect: 'none',
          listStyle: 'none',
        }}
      >
        <Icon name={icon} size={14} style={{ color }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{label}</span>
        {truncatedNote && (
          <span style={{ color: 'var(--text-dim)', fontWeight: 400, flexShrink: 0 }}>{truncatedNote}</span>
        )}
      </summary>
      <div
        style={{
          padding: '0 10px 10px',
          fontSize: 'var(--font-xs)',
          color: 'var(--text-dim)',
          fontFamily: "'JetBrainsMono Nerd Font', 'JetBrains Mono', monospace",
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflowX: 'auto',
        }}
      >
        {children}
      </div>
    </details>
  );
}
