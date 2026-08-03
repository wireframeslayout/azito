import { useCallback, useEffect, useRef, useState } from 'react';

export interface PaneRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export type PaneRectMap = Record<string, PaneRect>;

function rectsEqual(a: PaneRect, b: PaneRect): boolean {
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
}

function sameRectMap(prev: PaneRectMap, next: PaneRectMap): boolean {
  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(next);
  if (prevKeys.length !== nextKeys.length) return false;
  return nextKeys.every((key) => prev[key] && rectsEqual(prev[key], next[key]));
}

/**
 * Tracks the rect of every registered pane body element relative to a
 * container element, for the Workspace multi-pane content overlay (Issue
 * #397): `SplitLayout` renders the split "chrome" (tab bars, splitters) but
 * not tab content, so callers overlay their own content divs positioned via
 * these rects instead of `inset: 0`.
 *
 * Consumers call `onPaneBodyRef(paneId, el)` from `SplitLayout`'s
 * `onPaneBodyRef` prop to register/unregister a pane's body placeholder, and
 * attach `containerRef` to the positioned ancestor the rects are relative to.
 * On unregister (`el === null`), callers should also pass the element being
 * detached as a third argument when known, so a stale unregister can't clobber
 * a same-`paneId` element that already re-registered (see `onPaneBodyRef`'s
 * own doc below).
 * A `ResizeObserver` on the container and every registered pane body keeps
 * rects in sync with layout changes (splitter drags, window resize, sidebar
 * width changes) and pane registration changes (splits/merges). `rects`
 * keeps the same object reference when nothing has actually changed, so
 * callers can use it directly as a `useEffect`/`useMemo` dependency.
 */
export function usePaneRects() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const elsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [rects, setRects] = useState<PaneRectMap>({});

  const recompute = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const next: PaneRectMap = {};
    for (const [paneId, el] of elsRef.current) {
      const r = el.getBoundingClientRect();
      next[paneId] = {
        top: r.top - containerRect.top,
        left: r.left - containerRect.left,
        width: r.width,
        height: r.height,
      };
    }
    setRects((prev) => (sameRectMap(prev, next) ? prev : next));
  }, []);

  useEffect(() => {
    const ro = new ResizeObserver(() => recompute());
    resizeObserverRef.current = ro;
    if (containerRef.current) ro.observe(containerRef.current);
    // Pane body elements may have registered via onPaneBodyRef before this
    // effect ran (child refs commit before a parent's own effects), so
    // observe whatever is already tracked instead of missing it.
    for (const el of elsRef.current.values()) ro.observe(el);
    recompute();
    return () => {
      ro.disconnect();
      resizeObserverRef.current = null;
    };
  }, [recompute]);

  // `detachingEl` identifies *which* element a `null` (unregister) call refers to
  // (the caller's own last-registered element — see SplitLayoutPane's ref callback).
  // Without it, a `null` call can't tell a genuine removal apart from a late cleanup
  // that fires *after* a replacement element has already re-registered under the same
  // `paneId` (e.g. a pane body swapped out during a split/merge, if React processes
  // the new mount's ref-attach before the old node's ref-detach within the same
  // commit) — deleting unconditionally in that case would drop the live rect entry
  // for the new element that's already registered, leaving `rects` (and thus the
  // content overlay) stale until some unrelated resize happens to recompute it.
  const onPaneBodyRef = useCallback((paneId: string, el: HTMLDivElement | null, detachingEl?: HTMLDivElement | null) => {
    if (el) {
      const prevEl = elsRef.current.get(paneId);
      if (prevEl && prevEl !== el) resizeObserverRef.current?.unobserve(prevEl);
      elsRef.current.set(paneId, el);
      resizeObserverRef.current?.observe(el);
    } else {
      const current = elsRef.current.get(paneId);
      if (current && (detachingEl === undefined || current === detachingEl)) {
        resizeObserverRef.current?.unobserve(current);
        elsRef.current.delete(paneId);
      }
    }
    recompute();
  }, [recompute]);

  return { containerRef, onPaneBodyRef, rects };
}
