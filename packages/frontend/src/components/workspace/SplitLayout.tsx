import React, { useMemo, useRef, useState } from 'react';
import { listPanes, type LayoutNode, type SplitNode, type PaneNode, type DropZone } from '../../hooks/paneLayoutTree';
import { clampRatioForMinSizes, subtreeMinSizePx } from './paneDropZone';
import { SplitLayoutPane } from './SplitLayoutPane';

/** A tab being dragged, as tracked by the consumer (e.g. via TabBar's `onTabDragStart`/`onTabDragEnd`). */
export interface PaneDrag {
  tabId: string;
  fromPaneId: string;
}

export interface SplitLayoutProps {
  root: LayoutNode;
  focusedPaneId: string | null;
  /** Currently dragged tab, or null when no drag is in progress. Consumer-owned. */
  drag: PaneDrag | null;
  /** Renders a pane's tab bar (e.g. with the existing TabBar/MiniTabBar component). */
  renderPaneBar: (pane: PaneNode) => React.ReactNode;
  /** Renders a placeholder for a pane with no open tabs. */
  renderPaneEmpty?: (pane: PaneNode) => React.ReactNode;
  onFocusPane: (paneId: string) => void;
  onResize: (splitPath: string, ratio: number) => void;
  /** zone === 'tabbar' additionally passes the insertion index within the pane's tab bar. */
  onDrop: (paneId: string, zone: DropZone, index?: number) => void;
  /** Reports the pane body placeholder element for rect-sync-based content overlay (used by a later task). */
  onPaneBodyRef?: (paneId: string, el: HTMLDivElement | null, detachingEl?: HTMLDivElement | null) => void;
  minPanePx?: number;
}

const SPLITTER_PX = 4;
const DEFAULT_MIN_PANE_PX = 160;

/**
 * Renders the "chrome" of the Workspace multi-pane split layout tree
 * (Issue #397): split containers with draggable splitters, and per-pane tab
 * bars/focus ring/drop-zone overlays. Pane content itself is not rendered
 * here — callers overlay their own content using the rects reported via
 * `onPaneBodyRef`.
 */
export function SplitLayout({
  root,
  focusedPaneId,
  drag,
  renderPaneBar,
  renderPaneEmpty,
  onFocusPane,
  onResize,
  onDrop,
  onPaneBodyRef,
  minPanePx = DEFAULT_MIN_PANE_PX,
}: SplitLayoutProps): React.JSX.Element {
  const panes = useMemo(() => listPanes(root), [root]);
  const paneIds = useMemo(() => new Set(panes.map((p) => p.id)), [panes]);
  const showFocusRings = panes.length > 1;

  function renderNode(node: LayoutNode, splitPath: string): React.JSX.Element {
    if (node.type === 'pane') {
      return (
        <SplitLayoutPane
          key={node.id}
          pane={node}
          showFocusRing={showFocusRings && node.id === focusedPaneId}
          drag={drag}
          paneIds={paneIds}
          renderPaneBar={renderPaneBar}
          renderPaneEmpty={renderPaneEmpty}
          onFocusPane={onFocusPane}
          onDrop={onDrop}
          onPaneBodyRef={onPaneBodyRef}
        />
      );
    }
    return (
      <SplitContainer
        key={splitPath || 'root'}
        node={node}
        splitPath={splitPath}
        minPanePx={minPanePx}
        onResize={onResize}
      >
        {renderNode(node.a, `${splitPath}a`)}
        {renderNode(node.b, `${splitPath}b`)}
      </SplitContainer>
    );
  }

  return renderNode(root, '');
}

interface SplitContainerProps {
  node: SplitNode;
  splitPath: string;
  minPanePx: number;
  onResize: (splitPath: string, ratio: number) => void;
  children: [React.ReactNode, React.ReactNode];
}

function SplitContainer({ node, splitPath, minPanePx, onResize, children }: SplitContainerProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const originRef = useRef(0);
  const containerPxRef = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [hovering, setHovering] = useState(false);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    containerPxRef.current = node.dir === 'row' ? rect.width : rect.height;
    originRef.current = node.dir === 'row' ? rect.left : rect.top;
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const clientPos = node.dir === 'row' ? e.clientX : e.clientY;
    const raw = (clientPos - originRef.current) / containerPxRef.current;
    const minAPx = subtreeMinSizePx(node.a, node.dir, minPanePx, SPLITTER_PX);
    const minBPx = subtreeMinSizePx(node.b, node.dir, minPanePx, SPLITTER_PX);
    const clamped = clampRatioForMinSizes(containerPxRef.current, SPLITTER_PX, minAPx, minBPx, raw);
    onResize(splitPath, clamped);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDragging(false);
  };

  const active = dragging || hovering;
  const [childA, childB] = children;

  return (
    <div
      ref={containerRef}
      style={{ display: 'flex', flexDirection: node.dir === 'row' ? 'row' : 'column', width: '100%', height: '100%', minWidth: 0, minHeight: 0 }}
    >
      <div style={{ flex: `0 0 calc(${node.ratio * 100}% - ${SPLITTER_PX / 2}px)`, minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        {childA}
      </div>
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
        style={{
          flex: `0 0 ${SPLITTER_PX}px`,
          cursor: node.dir === 'row' ? 'col-resize' : 'row-resize',
          background: active ? 'var(--accent)' : 'var(--border)',
          touchAction: 'none',
        }}
      />
      <div style={{ flex: '1 1 0', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
        {childB}
      </div>
    </div>
  );
}
