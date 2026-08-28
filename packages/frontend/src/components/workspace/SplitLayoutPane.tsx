import React, { useCallback, useRef, useState } from 'react';
import type { PaneNode, DropZone } from '../../hooks/paneLayoutTree';
import { pickDropZone, pickDropIndex, type PaneRect } from './paneDropZone';
import type { PaneDrag } from './SplitLayout';

interface SplitLayoutPaneProps {
  pane: PaneNode;
  showFocusRing: boolean;
  drag: PaneDrag | null;
  paneIds: Set<string>;
  renderPaneBar: (pane: PaneNode) => React.ReactNode;
  renderPaneEmpty?: (pane: PaneNode) => React.ReactNode;
  onFocusPane: (paneId: string) => void;
  onDrop: (paneId: string, zone: DropZone, index?: number) => void;
  onPaneBodyRef?: (paneId: string, el: HTMLDivElement | null, detachingEl?: HTMLDivElement | null) => void;
}

function toRect(el: Element): PaneRect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

function zoneOverlayRect(zone: Exclude<DropZone, 'tabbar'>): React.CSSProperties {
  switch (zone) {
    case 'center': return { inset: 4 };
    case 'left': return { top: 0, left: 0, bottom: 0, right: '50%' };
    case 'right': return { top: 0, right: 0, bottom: 0, left: '50%' };
    case 'top': return { top: 0, left: 0, right: 0, bottom: '50%' };
    case 'bottom': return { bottom: 0, left: 0, right: 0, top: '50%' };
  }
}

export function SplitLayoutPane({
  pane, showFocusRing, drag, paneIds, renderPaneBar, renderPaneEmpty, onFocusPane, onDrop, onPaneBodyRef,
}: SplitLayoutPaneProps): React.JSX.Element {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [hoverZone, setHoverZone] = useState<DropZone | null>(null);
  // Tracks the element this callback last registered, so its own `null` (unregister)
  // call can identify *which* element it's detaching (see usePaneRects.onPaneBodyRef's
  // doc) instead of blindly clearing whatever the current registration happens to be.
  const lastRegisteredElRef = useRef<HTMLDivElement | null>(null);

  const paneBodyRefCallback = useCallback((el: HTMLDivElement | null) => {
    if (el) {
      lastRegisteredElRef.current = el;
      onPaneBodyRef?.(pane.id, el);
    } else {
      onPaneBodyRef?.(pane.id, null, lastRegisteredElRef.current);
      lastRegisteredElRef.current = null;
    }
  }, [pane.id, onPaneBodyRef]);

  const computeZone = (e: React.DragEvent): DropZone | null => {
    if (!wrapperRef.current || !barRef.current) return null;
    const barHeight = barRef.current.getBoundingClientRect().height;
    return pickDropZone(toRect(wrapperRef.current), barHeight, e.clientX, e.clientY);
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!drag) {
      if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    setHoverZone(computeZone(e));
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!drag) return;
    e.stopPropagation();
    setHoverZone(null);
  };

  const handleDrop = (e: React.DragEvent) => {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    setHoverZone(null);
    if (!paneIds.has(pane.id)) return;
    const zone = computeZone(e);
    if (!zone) return;
    if (zone === 'tabbar') {
      const tabEls = barRef.current ? Array.from(barRef.current.querySelectorAll('[data-tab-id]')) : [];
      const tabRects = tabEls.map(toRect);
      onDrop(pane.id, zone, pickDropIndex(tabRects, e.clientX));
    } else {
      onDrop(pane.id, zone);
    }
  };

  return (
    <div
      ref={wrapperRef}
      onPointerDown={() => onFocusPane(pane.id)}
      onDragOver={handleDragOver}
      onDragEnter={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minWidth: 0, minHeight: 0, position: 'relative' }}
    >
      <div ref={barRef} style={{ position: 'relative', flexShrink: 0 }}>
        {renderPaneBar(pane)}
        {hoverZone === 'tabbar' && (
          <div style={{ position: 'absolute', inset: 0, zIndex: 10, background: 'var(--accent-a15)', borderBottom: '2px solid var(--accent)', pointerEvents: 'none' }} />
        )}
      </div>
      <div
        ref={paneBodyRefCallback}
        style={{ flex: '1 1 0', minHeight: 0, position: 'relative' }}
      >
        {pane.tabIds.length === 0 && renderPaneEmpty?.(pane)}
        {hoverZone && hoverZone !== 'tabbar' && (
          <div style={{ position: 'absolute', zIndex: 10, pointerEvents: 'none', background: 'var(--accent-a15)', border: '1.5px dashed var(--accent)', ...zoneOverlayRect(hoverZone) }} />
        )}
      </div>
      {showFocusRing && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 10, border: '1px solid var(--accent-a35)', pointerEvents: 'none' }} />
      )}
    </div>
  );
}
