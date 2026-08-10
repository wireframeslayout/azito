import { useEffect, useRef } from 'react';

export interface GlassPopoverItem {
  key: string;
  label: React.ReactNode;
  icon?: React.ReactNode;
  selected?: boolean;
  onSelect: () => void;
}

export interface GlassPopoverProps {
  open: boolean;
  onClose: () => void;
  label?: string;
  items: GlassPopoverItem[];
  align?: 'left' | 'right' | 'center';
  ariaLabel?: string;
}

/**
 * ガラス表現のポップオーバー。プロジェクト切替・その他・設定の各メニューとして利用する
 * 汎用コンポーネント。外側タップ / Esc で閉じる。prefers-reduced-motion 時はアニメーション
 * 無効（global.css）。
 */
export function GlassPopover({ open, onClose, label, items, align = 'left', ariaLabel }: GlassPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  const horizontal: React.CSSProperties = align === 'right'
    ? { right: 14 }
    : align === 'center'
      ? { left: '50%', transform: open ? 'translate(-50%, 0) scale(1)' : 'translate(-50%, 6px) scale(0.98)' }
      : { left: 14 };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={ariaLabel}
      className="glass-popover"
      inert={!open}
      style={{
        position: 'fixed',
        bottom: 'calc(76px + env(safe-area-inset-bottom))',
        borderRadius: 'var(--radius-lg)',
        background: 'rgba(22, 27, 34, 0.86)',
        border: '1px solid rgba(139, 148, 158, 0.25)',
        backdropFilter: 'blur(16px) saturate(1.3)',
        WebkitBackdropFilter: 'blur(16px) saturate(1.3)',
        boxShadow: '0 12px 36px rgba(0, 0, 0, 0.5)',
        padding: 6,
        minWidth: 190,
        zIndex: 130,
        opacity: open ? 1 : 0,
        visibility: open ? 'visible' : 'hidden',
        transform: align === 'center' ? undefined : (open ? 'none' : 'translateY(6px) scale(0.98)'),
        transformOrigin: 'bottom center',
        pointerEvents: open ? 'auto' : 'none',
        transition: 'opacity 0.16s ease, transform 0.16s ease, visibility 0.16s ease',
        ...horizontal,
      }}
    >
      {label && (
        <div style={{ fontSize: 'var(--font-2xs)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', padding: '6px 10px 4px' }}>
          {label}
        </div>
      )}
      {items.map((item) => (
        <button
          key={item.key}
          role="menuitem"
          tabIndex={open ? 0 : -1}
          className={`glass-popover-item${item.selected ? ' selected' : ''}`}
          onClick={item.onSelect}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            width: '100%',
            border: 'none',
            color: 'var(--text)',
            fontSize: 'var(--font-md)',
            fontFamily: 'inherit',
            padding: '9px 10px',
            borderRadius: 'var(--radius-md)',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          {item.icon}
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
          {item.selected && <span style={{ color: 'var(--accent)', fontSize: 'var(--font-sm)' }}>&#10003;</span>}
        </button>
      ))}
    </div>
  );
}
