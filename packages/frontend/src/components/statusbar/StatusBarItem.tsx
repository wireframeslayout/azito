import { useRef, forwardRef, useImperativeHandle } from 'react';
import { HealthDot } from './HealthDot';
import type { DotLevel } from './HealthDot';

interface StatusBarItemProps {
  label: string;
  dot: DotLevel;
  active: boolean;
  onClick: () => void;
}

export interface StatusBarItemRef {
  getBoundingRect: () => DOMRect | null;
}

export const StatusBarItem = forwardRef<StatusBarItemRef, StatusBarItemProps>(
  function StatusBarItem({ label, dot, active, onClick }, ref) {
    const btnRef = useRef<HTMLButtonElement>(null);

    useImperativeHandle(ref, () => ({
      getBoundingRect: () => btnRef.current?.getBoundingClientRect() ?? null,
    }));

    return (
      <button
        ref={btnRef}
        onClick={onClick}
        aria-haspopup="true"
        aria-expanded={active}
        className={active ? undefined : 'row-hover'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: '2px 10px',
          borderRadius: 'var(--radius-sm)',
          cursor: 'pointer',
          background: active ? 'var(--bg-hover)' : 'transparent',
          color: active ? 'var(--text)' : 'var(--text-dim)',
          border: 'none',
          fontFamily: 'var(--mono)',
          fontSize: 'var(--font-xs)',
          transition: 'background 0.15s, color 0.15s',
        }}
      >
        <HealthDot level={dot} />
        {label}
      </button>
    );
  }
);
