/**
 * Pure geometry for the per-tab content overlay used by a multi-pane split's content area
 * (TaskPanel's task-scoped panes; see paneDropZone.ts for the sibling split-chrome geometry
 * shared with Workspace's own workspace-level panes). Each open tab gets one absolutely
 * positioned wrapper div, sized/positioned to exactly cover its pane's measured body rect
 * (`usePaneRects`); only the pane's own *active* tab is actually visible/interactive.
 *
 * No React/DOM dependency — callers pass in the already-measured rect (or `undefined` when
 * `usePaneRects` hasn't measured that pane yet).
 */
import type { PaneRect } from '../../hooks/usePaneRects';

export interface PaneTabOverlayStyle {
  position: 'absolute';
  top: number;
  left: number;
  width: number;
  height: number;
  overflow?: 'hidden';
  visibility: 'visible' | 'hidden';
  pointerEvents: 'auto' | 'none';
}

/**
 * `rect` is `undefined` for a pane that hasn't been measured yet — most notably the instant
 * a brand-new pane is created by dragging a tab into a split (its body element mounts, and
 * becomes that tab's pane, before `usePaneRects`'s observer has reported its rect back).
 *
 * That "not yet measured" case must produce a wrapper that is *unconditionally*
 * non-interactive and hidden, regardless of `tabVisible` — never let `tabVisible` override
 * it back to visible. CSS `visibility: hidden` is inherited by descendants and removes them
 * from hit-testing even when they lay out/paint past their own (0×0, unmeasured) ancestor's
 * box; the moment something forces that ancestor back to `visibility: visible` before a real
 * rect exists, its content renders at the container's (0, 0) origin at its own natural
 * (possibly overflowing) size, `pointerEvents: 'auto'` and all — sitting on top of, and
 * intercepting clicks/drags meant for, whichever pane actually occupies that corner. That
 * previously-real bug (`rect` missing didn't stop `visibility: tabVisible ? 'visible' :
 * 'hidden'` from firing) is exactly the "invisible element steals pointer events" failure
 * mode this function exists to make structurally impossible to reintroduce.
 */
export function computeTabOverlayStyle(rect: PaneRect | undefined, tabVisible: boolean, interactive: boolean): PaneTabOverlayStyle {
  if (!rect) {
    return { position: 'absolute', top: 0, left: 0, width: 0, height: 0, visibility: 'hidden', pointerEvents: 'none' };
  }
  return {
    position: 'absolute', top: rect.top, left: rect.left, width: rect.width, height: rect.height,
    overflow: 'hidden',
    visibility: tabVisible ? 'visible' : 'hidden',
    pointerEvents: interactive ? 'auto' : 'none',
  };
}
