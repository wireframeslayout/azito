import React from 'react';

export function IconButton({
  title,
  onClick,
  children,
  size = 'md',
  style,
  ...rest
}: {
  title?: string;
  onClick?: () => void;
  children: React.ReactNode;
  size?: 'sm' | 'md';
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const sizeStyles = size === 'sm'
    ? { padding: '2px 4px', fontSize: 'var(--font-sm)' }
    : { padding: '4px 8px', fontSize: 'var(--font-base)' };

  return (
    <button
      title={title}
      onClick={onClick}
      className="icon-btn"
      style={{
        background: 'none',
        border: 'none',
        color: 'var(--text-dim)',
        cursor: 'pointer',
        ...sizeStyles,
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}
