import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { useLongPress, longPressStyle } from '../../hooks/useLongPress';
import { useTabStripScrolling } from '../../hooks/useTabStripScrolling';

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return `rgba(139,148,158,${alpha})`;
  return `rgba(${r},${g},${b},${alpha})`;
}

export interface TabItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  closable?: boolean;
  extra?: React.ReactNode;
  projectColor?: string;
  pinned?: boolean;
  className?: string;
  dirty?: boolean;
}

export interface TabBarProps {
  tabs: TabItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose?: (id: string) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
  draggable?: boolean;
  renderTab?: (tab: TabItem, isActive: boolean) => React.ReactNode;
  onTabContextMenu?: (e: React.MouseEvent, tabId: string) => void;
  onTabLongPress?: (x: number, y: number, tabId: string) => void;
  /** Action area rendered between the tab strip and the ▾ tab-list button (e.g. pane-mode split/close buttons). */
  trailing?: React.ReactNode;
  /**
   * When provided, tabs become HTML5-draggable (`draggable` DOM attribute)
   * and report drag lifecycle via these callbacks instead of the mousedown-based
   * `onReorder` flow — used by cross-pane tab drag-and-drop, where the drop
   * target is a different TabBar instance. Providing either callback disables
   * `startTabDrag` for this TabBar so the two mechanisms never fight over the
   * same pointer gesture.
   */
  onTabDragStart?: (tabId: string) => void;
  onTabDragEnd?: () => void;
}

export function TabBar({ tabs, activeId, onSelect, onClose, onReorder, draggable = false, renderTab, onTabContextMenu, onTabLongPress, trailing, onTabDragStart, onTabDragEnd }: TabBarProps) {
  const html5Draggable = onTabDragStart !== undefined || onTabDragEnd !== undefined;
  const { attachRef: attachScrollRef, elRef: tabBarRef } = useTabStripScrolling(activeId);
  const bindLongPress = useLongPress();
  const [showTabMenu, setShowTabMenu] = useState(false);
  const [dragTabId, setDragTabId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const dropIndexRef = useRef<number | null>(null);
  const dragStartX = useRef(0);
  const dragStarted = useRef(false);

  useEffect(() => {
    if (!showTabMenu) return;
    const handler = () => setShowTabMenu(false);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [showTabMenu]);

  const startTabDrag = useCallback((tabId: string, e: React.MouseEvent) => {
    if (!draggable || html5Draggable) return;
    dragStartX.current = e.clientX;
    dragStarted.current = false;
    const handleMove = (me: MouseEvent) => {
      if (!dragStarted.current && Math.abs(me.clientX - dragStartX.current) > 5) {
        dragStarted.current = true;
        setDragTabId(tabId);
        document.body.style.userSelect = 'none';
      }
      if (dragStarted.current && tabBarRef.current) {
        const children = Array.from(tabBarRef.current.querySelectorAll('[data-tab-id]')) as HTMLElement[];
        let newDropIndex: number | null = null;
        for (let i = 0; i < children.length; i++) {
          const rect = children[i].getBoundingClientRect();
          const midX = rect.left + rect.width / 2;
          if (me.clientX < midX) {
            newDropIndex = i;
            break;
          }
        }
        if (newDropIndex === null) newDropIndex = children.length;
        setDropIndex(newDropIndex);
        dropIndexRef.current = newDropIndex;
      }
    };
    const handleUp = () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
      document.body.style.userSelect = '';
      if (dragStarted.current && tabId && dropIndexRef.current !== null) {
        if (onReorder) {
          const fromIdx = tabs.findIndex((t) => t.id === tabId);
          if (fromIdx >= 0) {
            const toIdx = Math.min(dropIndexRef.current, tabs.length - 1);
            if (toIdx >= 0 && fromIdx !== toIdx) onReorder(fromIdx, toIdx);
          }
        }
      }
      setDragTabId(null);
      setDropIndex(null);
      dropIndexRef.current = null;
      dragStarted.current = false;
    };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
  }, [tabs, onReorder, draggable, html5Draggable]);

  const renderSingleTab = (tab: TabItem, isDragging: boolean, showDropBefore: boolean) => {
    const isActive = tab.id === activeId;

    const html5DragProps = html5Draggable ? {
      draggable: true,
      onDragStart: (e: React.DragEvent) => {
        e.dataTransfer.setData('text/plain', tab.id);
        // Explicit marker so drop targets that aren't pane drop-zones (e.g. useDragUpload's
        // file-upload overlay) can tell a pane-tab drag apart from an OS file drag using
        // only `dataTransfer.types` — `getData` isn't readable until the `drop` event.
        e.dataTransfer.setData('application/x-azito-tab', tab.id);
        e.dataTransfer.effectAllowed = 'move';
        onTabDragStart?.(tab.id);
      },
      onDragEnd: () => onTabDragEnd?.(),
    } : {};

    if (renderTab) {
      return (
        <div
          key={tab.id}
          data-tab-id={tab.id}
          className={tab.className || ''}
          onMouseDown={draggable ? (e) => { if (e.button === 0) startTabDrag(tab.id, e); } : undefined}
          {...html5DragProps}
          style={{
            borderLeft: showDropBefore ? '2px solid var(--accent)' : '2px solid transparent',
            opacity: isDragging ? 0.5 : 1,
          }}
        >
          {renderTab(tab, isActive)}
        </div>
      );
    }

    return (
      <div
        key={tab.id}
        data-tab-id={tab.id}
        className={tab.className || ''}
        onMouseDown={draggable ? (e) => { if (e.button === 0) startTabDrag(tab.id, e); } : undefined}
        onContextMenu={onTabContextMenu ? (e) => { e.preventDefault(); onTabContextMenu(e, tab.id); } : undefined}
        {...(onTabLongPress ? bindLongPress((x, y) => onTabLongPress(x, y, tab.id)) : {})}
        {...html5DragProps}
        style={{
          ...(onTabLongPress ? longPressStyle : {}),
          padding: '8px 14px',
          fontSize: 'var(--font-sm)',
          color: isActive ? 'var(--text)' : 'var(--text-dim)',
          cursor: 'pointer',
          borderBottom: `2px solid ${isActive ? 'var(--accent)' : 'transparent'}`,
          borderLeft: showDropBefore ? '2px solid var(--accent)' : '2px solid transparent',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minHeight: 44,
          maxWidth: 200,
          opacity: isDragging ? 0.5 : 1,
          background: tab.projectColor ? hexToRgba(tab.projectColor, 0.08) : undefined,
        }}
      >
        <span onClick={() => onSelect(tab.id)} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {tab.pinned && <span style={{ display: 'inline-flex', opacity: 0.6, marginRight: 2, verticalAlign: '-1px' }}><Icon name="pin" size={14} /></span>}
          {tab.dirty && <span style={{ color: 'var(--text-dim)', marginRight: 2 }}>●</span>}
          {tab.icon != null && <>{tab.icon} </>}{tab.label}
        </span>
        {tab.extra}
        {tab.closable !== false && onClose && (
          <span onClick={() => onClose(tab.id)} className="icon-btn" style={{ color: 'var(--text-dim)', cursor: 'pointer', padding: '3px 4px', flexShrink: 0, display: 'inline-flex' }}><Icon name="close" size={14} /></span>
        )}
      </div>
    );
  };

  return (
    <div className="ws-surface" style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--border)', background: 'var(--ws-surface-card)', minHeight: 44, position: 'relative' }}>
      <div ref={attachScrollRef} style={{ display: 'flex', flex: 1, overflowX: 'auto', scrollbarWidth: 'none' }}>
        {tabs.map((tab, idx) => {
          const isDragging = dragTabId === tab.id;
          const showDropBefore = dropIndex === idx && dragTabId !== null && dragTabId !== tab.id;
          return renderSingleTab(tab, isDragging, showDropBefore);
        })}
        {dropIndex !== null && dropIndex >= tabs.length && dragTabId !== null && (
          <div style={{ width: 2, background: 'var(--accent)', flexShrink: 0 }} />
        )}
      </div>

      {trailing && (
        <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
          {trailing}
        </div>
      )}

      {tabs.length > 0 && (
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button onClick={(e) => { e.stopPropagation(); setShowTabMenu(!showTabMenu); }} className="icon-btn" style={{ border: 'none', color: 'var(--text-dim)', cursor: 'pointer', padding: '8px 10px', minHeight: 44, display: 'flex', alignItems: 'center' }}><Icon name="chevrons-up-down" size={14} /></button>
          {showTabMenu && (
            <div onClick={(e) => e.stopPropagation()} style={{ position: 'absolute', top: '100%', right: 0, zIndex: 100, background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', boxShadow: '0 4px 16px rgba(0,0,0,0.3)', minWidth: 220, maxHeight: 400, overflowY: 'auto', padding: '4px 0' }}>
              {tabs.map(tab => (
                <div key={tab.id} onClick={() => { onSelect(tab.id); setShowTabMenu(false); }}
                  style={{ padding: '8px 12px', fontSize: 'var(--font-sm)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, background: tab.id === activeId ? 'var(--accent-a15)' : tab.projectColor ? hexToRgba(tab.projectColor, 0.08) : 'transparent', color: tab.id === activeId ? 'var(--accent)' : 'var(--text)' }}>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {tab.pinned && <span style={{ display: 'inline-flex', opacity: 0.6, marginRight: 4, verticalAlign: '-1px' }}><Icon name="pin" size={14} /></span>}
                    {tab.dirty && <span style={{ color: 'var(--text-dim)', marginRight: 2 }}>●</span>}
                    {tab.icon != null && <>{tab.icon} </>}{tab.label}
                  </span>
                  {tab.closable !== false && onClose && (
                    <span onClick={(e) => { e.stopPropagation(); onClose(tab.id); }} className="icon-btn" style={{ color: 'var(--text-dim)', cursor: 'pointer', padding: '3px 4px', flexShrink: 0, display: 'inline-flex' }}><Icon name="close" size={14} /></span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
