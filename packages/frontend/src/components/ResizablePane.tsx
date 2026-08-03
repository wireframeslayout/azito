import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './ui/Icon';

interface ResizablePaneProps {
  children: React.ReactNode;
  initialWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  open: boolean;
  onToggle: () => void;
  storageKey?: string;
}

export default function ResizablePane({
  children,
  initialWidth = 280,
  minWidth = 200,
  maxWidth = 500,
  open,
  onToggle,
  storageKey,
}: ResizablePaneProps) {
  const [width, setWidth] = useState(() => {
    if (storageKey) {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed) && parsed >= minWidth && parsed <= maxWidth) return parsed;
      }
    }
    return initialWidth;
  });

  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  useEffect(() => {
    if (storageKey) {
      localStorage.setItem(storageKey, String(width));
    }
  }, [width, storageKey]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startX.current = e.clientX;
    startWidth.current = width;

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const delta = startX.current - ev.clientX;
      const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth.current + delta));
      setWidth(newWidth);
    };

    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [width, minWidth, maxWidth]);

  if (!open) {
    return (
      <div style={{
        borderLeft: '1px solid var(--border)',
        display: 'flex',
        alignItems: 'flex-start',
        flexShrink: 0,
      }}>
        <button
          onClick={onToggle}
          title="Show details"
          className="icon-btn"
          style={{
            border: 'none',
            color: 'var(--text-dim)',
            cursor: 'pointer',
            padding: '8px 6px',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <Icon name="chevron-left" size={16} />
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexShrink: 0 }}>
      <div
        onMouseDown={onMouseDown}
        style={{
          width: 4,
          cursor: 'col-resize',
          background: 'var(--border)',
          flexShrink: 0,
          position: 'relative',
        }}
      >
        <div style={{
          position: 'absolute',
          top: 0,
          left: -2,
          right: -2,
          bottom: 0,
        }} />
      </div>
      <div style={{
        width,
        minWidth,
        maxWidth,
        background: 'var(--bg-card)',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
      }}>
        <div style={{
          display: 'flex',
          justifyContent: 'flex-end',
          padding: '4px 8px 0',
          flexShrink: 0,
        }}>
          <button
            onClick={onToggle}
            title="Hide details"
            className="icon-btn"
            style={{
              border: 'none',
              color: 'var(--text-dim)',
              cursor: 'pointer',
              padding: '4px 6px',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <Icon name="chevron-right" size={16} />
          </button>
        </div>
        <div style={{ padding: '0 16px 16px', flex: 1 }}>
          {children}
        </div>
      </div>
    </div>
  );
}
