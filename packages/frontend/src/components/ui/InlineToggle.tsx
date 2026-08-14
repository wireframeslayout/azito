import type { CSSProperties, ReactNode } from 'react';

interface InlineToggleProps {
  active: boolean;
  onClick: () => void;
  title: string;
  children: ReactNode;
  style?: CSSProperties;
}

export function InlineToggle({ active, onClick, title, children, style }: InlineToggleProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={active}
      title={title}
      onClick={onClick}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, padding: 0,
        border: active ? '1px solid var(--accent-a35)' : '1px solid transparent', borderRadius: 3,
        background: active ? 'var(--accent-a15)' : 'transparent', color: active ? 'var(--accent)' : 'var(--text-dim)',
        cursor: 'pointer', fontSize: 11, fontWeight: 600, fontFamily: 'inherit', lineHeight: 1, flexShrink: 0, ...style,
      }}
    >
      {children}
    </button>
  );
}
