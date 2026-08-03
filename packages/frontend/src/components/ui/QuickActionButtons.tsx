import React from 'react';

export interface QuickActionButton {
  label: React.ReactNode;
  key: string;
  style?: React.CSSProperties;
}

interface QuickActionButtonsProps {
  buttons: QuickActionButton[];
  onAction: (key: string) => void;
}

const baseStyle: React.CSSProperties = {
  background: 'rgba(230, 237, 243, 0.05)',
  border: '1px solid rgba(139, 148, 158, 0.28)',
  color: 'var(--text)',
  borderRadius: 'var(--radius-sm)',
  padding: '0 10px',
  fontSize: 'var(--font-xs)',
  fontWeight: 500,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  height: 30,
  minWidth: 38,
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'inherit',
  transition: 'background 0.15s ease',
};

export function QuickActionButtons({ buttons, onAction }: QuickActionButtonsProps) {
  return (
    <div style={{ display: 'flex', gap: 6, overflowX: 'auto' }}>
      {buttons.map((btn) => (
        <button
          key={btn.key}
          className="qa-btn"
          onClick={() => onAction(btn.key)}
          style={{ ...baseStyle, ...btn.style }}
        >
          {btn.label}
        </button>
      ))}
    </div>
  );
}
