import React from 'react';
import { useTabStripScrolling } from '../../hooks/useTabStripScrolling';
import { Icon } from './Icon';

export interface MiniTab {
  key: string;
  label: string;
  disabled?: boolean;
  /** Rendered before the label (e.g. a favicon or loading spinner). */
  prefix?: React.ReactNode;
  extra?: React.ReactNode;
  /** Native tooltip shown on hover; defaults to `label` when omitted. */
  title?: string;
  /** Whether this tab shows a close (×) affordance when `onClose` is provided. Defaults to true. */
  closable?: boolean;
}

interface MiniTabBarProps {
  tabs: MiniTab[];
  activeKey: string;
  onSelect: (key: string) => void;
  size?: 'sm' | 'md';
  /** Action area rendered after the tab strip (e.g. split/close-pane buttons). */
  trailing?: React.ReactNode;
  /** Renders a close (×) affordance on tabs with `closable !== false`. */
  onClose?: (key: string) => void;
  /**
   * When provided (either callback), tabs become HTML5-draggable and report
   * drag lifecycle via these instead of being static — used by cross-pane
   * tab drag-and-drop.
   */
  onTabDragStart?: (key: string) => void;
  onTabDragEnd?: () => void;
  onTabContextMenu?: (e: React.MouseEvent, key: string) => void;
}

export function MiniTabBar({
  tabs, activeKey, onSelect, size = 'sm', trailing, onClose, onTabDragStart, onTabDragEnd, onTabContextMenu,
}: MiniTabBarProps) {
  const fontSize = size === 'sm' ? 11 : 12;
  const padding = size === 'sm' ? '6px 10px' : '8px 14px';
  const draggable = onTabDragStart !== undefined || onTabDragEnd !== undefined;
  const { attachRef: attachScrollRef } = useTabStripScrolling(activeKey);

  return (
    <div style={{
      display: 'flex', borderBottom: '1px solid var(--border)',
      gap: 0, flexShrink: 0, alignItems: 'center',
    }}>
      <div ref={attachScrollRef} style={{ display: 'flex', flex: 1, overflowX: 'auto', scrollbarWidth: 'none', minWidth: 0 }}>
        {tabs.map((tab) => {
          const isActive = tab.key === activeKey;
          return (
            <button
              key={tab.key}
              data-tab-id={tab.key}
              draggable={draggable}
              onDragStart={draggable ? (e) => {
                e.dataTransfer.setData('text/plain', tab.key);
                // Explicit marker so drop targets that aren't pane drop-zones (e.g.
                // useDragUpload's file-upload overlay) can tell a pane-tab drag apart from
                // an OS file drag using only `dataTransfer.types` — `getData` isn't
                // readable until the `drop` event.
                e.dataTransfer.setData('application/x-azito-tab', tab.key);
                e.dataTransfer.effectAllowed = 'move';
                onTabDragStart?.(tab.key);
              } : undefined}
              onDragEnd={draggable ? () => onTabDragEnd?.() : undefined}
              onContextMenu={onTabContextMenu ? (e) => { e.preventDefault(); onTabContextMenu(e, tab.key); } : undefined}
              onClick={() => { if (!tab.disabled) onSelect(tab.key); }}
              disabled={tab.disabled}
              title={tab.title ?? tab.label}
              style={{
                padding, fontSize, border: 'none', background: 'none',
                cursor: tab.disabled ? 'default' : 'pointer',
                color: isActive ? 'var(--text)' : 'var(--text-dim)',
                borderBottom: `2px solid ${isActive ? 'var(--accent)' : 'transparent'}`,
                fontWeight: isActive ? 600 : 400,
                opacity: tab.disabled ? 0.5 : 1,
                transition: 'color 0.1s',
                display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0,
              }}
            >
              {tab.prefix}
              {tab.label}
              {tab.extra}
              {tab.closable !== false && onClose && (
                <span
                  onClick={(e) => { e.stopPropagation(); onClose(tab.key); }}
                  className="icon-btn"
                  style={{ display: 'inline-flex', alignItems: 'center', color: 'var(--text-dim)', cursor: 'pointer', padding: '0 2px', borderRadius: 'var(--radius-sm)', lineHeight: 1 }}
                ><Icon name="close" size={14} /></span>
              )}
            </button>
          );
        })}
      </div>
      {trailing && (
        <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0, gap: 2 }}>
          {trailing}
        </div>
      )}
    </div>
  );
}
