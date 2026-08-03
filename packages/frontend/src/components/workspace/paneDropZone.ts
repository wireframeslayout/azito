/**
 * Pure geometry helpers for the Workspace multi-pane split drag-and-drop UI
 * (Issue #397). No React/DOM dependency — callers pass in already-measured
 * rectangles (e.g. from `getBoundingClientRect()`).
 */

export type { DropZone } from '../../hooks/paneLayoutTree';
import type { DropZone, LayoutNode } from '../../hooks/paneLayoutTree';

export interface PaneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const CENTER_MIN = 0.28;
const CENTER_MAX = 0.72;

/**
 * Classifies a pointer position against a pane's rect into a drop zone.
 * Positions within `barHeight` of the top edge are always `'tabbar'`
 * (dropping onto the pane's tab strip). Otherwise the position is expressed
 * as fractional (x, y) coordinates within the *content* area (i.e. below the
 * tab bar): the inner box [0.28, 0.72]^2 is `'center'`; outside that box, the
 * nearest edge wins.
 */
export function pickDropZone(rect: PaneRect, barHeight: number, clientX: number, clientY: number): DropZone {
  const relY = clientY - rect.top;
  if (relY <= barHeight) return 'tabbar';

  const contentHeight = Math.max(rect.height - barHeight, 1);
  const x = (clientX - rect.left) / Math.max(rect.width, 1);
  const y = (relY - barHeight) / contentHeight;

  if (x > CENTER_MIN && x < CENTER_MAX && y > CENTER_MIN && y < CENTER_MAX) return 'center';

  const distX = Math.min(x, 1 - x);
  const distY = Math.min(y, 1 - y);
  if (distX < distY) {
    return x < 0.5 ? 'left' : 'right';
  }
  return y < 0.5 ? 'top' : 'bottom';
}

/**
 * Given the rects of a row of tabs (in display order), returns the insertion
 * index implied by `clientX`: the index of the first tab whose horizontal
 * midpoint is to the right of `clientX`, or the array length if none is
 * (i.e. append at the end).
 */
export function pickDropIndex(tabRects: PaneRect[], clientX: number): number {
  for (let i = 0; i < tabRects.length; i++) {
    const rect = tabRects[i];
    const midX = rect.left + rect.width / 2;
    if (clientX < midX) return i;
  }
  return tabRects.length;
}

const HARD_MIN_RATIO = 0.15;
const HARD_MAX_RATIO = 0.85;

/**
 * Clamps a split ratio so that side `a` never drops below `minAPx` and side
 * `b` never drops below `minBPx` (accounting for the splitter's own
 * width/height), while never exceeding the [0.15, 0.85] hard bounds. If the
 * container is too small for both constraints to hold simultaneously, falls
 * back to an even 0.5 split.
 *
 * `minAPx`/`minBPx` should be each side's full *subtree* minimum (see
 * `subtreeMinSizePx`), not just a single pane's minimum — a side that is
 * itself a nested split needs room for its own descendants, not just one
 * `minPanePx`.
 */
export function clampRatioForMinSizes(containerPx: number, splitterPx: number, minAPx: number, minBPx: number, ratio: number): number {
  const available = containerPx - splitterPx;
  if (available < minAPx + minBPx) return 0.5;

  const minRatio = Math.max(HARD_MIN_RATIO, minAPx / available);
  const maxRatio = Math.min(HARD_MAX_RATIO, 1 - minBPx / available);
  if (minRatio > maxRatio) return 0.5;

  return Math.max(minRatio, Math.min(maxRatio, ratio));
}

/**
 * Recursively computes the minimum pixel size a subtree needs along `axis`
 * (the direction of the split being resized):
 * - a pane leaf needs `minPanePx`.
 * - a split whose own `dir` matches `axis` divides space along that axis, so
 *   its minimum is `min(a) + min(b) + splitterPx`.
 * - a split whose `dir` is orthogonal to `axis` stacks `a`/`b` across that
 *   axis (each spans the full axis extent), so its minimum is
 *   `max(min(a), min(b))`.
 */
export function subtreeMinSizePx(node: LayoutNode, axis: 'row' | 'col', minPanePx: number, splitterPx: number): number {
  if (node.type === 'pane') return minPanePx;
  const minA = subtreeMinSizePx(node.a, axis, minPanePx, splitterPx);
  const minB = subtreeMinSizePx(node.b, axis, minPanePx, splitterPx);
  return node.dir === axis ? minA + minB + splitterPx : Math.max(minA, minB);
}
