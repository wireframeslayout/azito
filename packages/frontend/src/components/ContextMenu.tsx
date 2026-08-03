import { useCallback, useState } from 'react';
import { Icon } from './ui/Icon';
import type { ReactNode } from 'react';
import { useClickOutside } from '../hooks/useClickOutside';

export interface ContextMenuItem {
  label: string;
  icon?: string | ReactNode;
  danger?: boolean;
  selected?: boolean;
  disabled?: boolean;
  title?: string;
  separator?: boolean;
  onClick: () => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export function useContextMenu() {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const show = useCallback((e: React.MouseEvent, items: ContextMenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    const x = Math.max(8, Math.min(e.clientX, window.innerWidth - 180));
    const y = Math.max(8, Math.min(e.clientY, window.innerHeight - items.length * 36 - 16));
    setMenu({ x, y, items });
  }, []);

  const showAt = useCallback((x: number, y: number, items: ContextMenuItem[]) => {
    const adjustedX = Math.max(8, Math.min(x, window.innerWidth - 180));
    const adjustedY = Math.max(8, Math.min(y, window.innerHeight - items.length * 36 - 16));
    setMenu({ x: adjustedX, y: adjustedY, items });
  }, []);

  const hide = useCallback(() => setMenu(null), []);

  return { menu, show, showAt, hide };
}

export default function ContextMenu({ menu, onClose }: { menu: ContextMenuState; onClose: () => void }) {
  const ref = useClickOutside<HTMLDivElement>(onClose);

  return (
    <div ref={ref} style={{
      position: 'fixed', top: menu.y, left: menu.x, zIndex: 310,
      background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
      boxShadow: '0 4px 16px rgba(0,0,0,0.4)', padding: '4px 0', minWidth: 160,
      maxHeight: 'min(320px, calc(100vh - 16px))', overflowY: 'auto',
    }}>
      {menu.items.map((item, i) => (
        item.separator ? (
          <div key={i} style={{ borderTop: '1px solid var(--border)', margin: '4px 0' }} />
        ) : (
        <button key={i}
          disabled={item.disabled}
          title={item.title}
          onClick={() => { if (item.disabled) return; item.onClick(); onClose(); }}
          className={`row-hover${item.selected ? ' row-selected' : ''}`}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, width: '100%',
            padding: '8px 14px', fontSize: 'var(--font-md)', cursor: item.disabled ? 'not-allowed' : 'pointer',
            border: 'none', textAlign: 'left', opacity: item.disabled ? 0.5 : 1,
            color: item.danger ? 'var(--danger)' : item.selected ? 'var(--accent)' : 'var(--text)',
          }}
        >
          {item.icon && <span style={{ width: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{item.icon}</span>}
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
          {item.selected && <span style={{ color: 'var(--accent)', flexShrink: 0, display: 'inline-flex' }}><Icon name="check" size={14} /></span>}
        </button>
        )
      ))}
    </div>
  );
}
