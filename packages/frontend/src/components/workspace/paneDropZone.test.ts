import { describe, it, expect } from 'vitest';
import { pickDropZone, pickDropIndex, clampRatioForMinSizes, subtreeMinSizePx, type PaneRect } from './paneDropZone';
import type { LayoutNode, PaneNode, SplitNode } from '../../hooks/paneLayoutTree';

describe('pickDropZone', () => {
  const rect: PaneRect = { left: 100, top: 100, width: 200, height: 200 };
  const barHeight = 32;

  it('returns tabbar when within barHeight of the top edge', () => {
    expect(pickDropZone(rect, barHeight, 150, 100)).toBe('tabbar');
    expect(pickDropZone(rect, barHeight, 150, 131)).toBe('tabbar');
    expect(pickDropZone(rect, barHeight, 150, 132)).toBe('tabbar');
  });

  it('returns tabbar exactly at the barHeight boundary and top just past it', () => {
    // relY === barHeight is still within the tabbar band (<=).
    expect(pickDropZone(rect, barHeight, 200, 100 + barHeight)).toBe('tabbar');
    // relY just past barHeight, centered horizontally -> content area, right at
    // its top edge (well outside the center box vertically) -> 'top'.
    expect(pickDropZone(rect, barHeight, 200, 100 + barHeight + 1)).toBe('top');
  });

  it('returns center for the inner box of the content area', () => {
    // Content area: top = 132, height = 168. Center of content -> (200, 216).
    expect(pickDropZone(rect, barHeight, 200, 216)).toBe('center');
  });

  it('returns left/right/top/bottom for the nearest edge outside the center box', () => {
    // Far left, vertically centered in content area.
    expect(pickDropZone(rect, barHeight, 105, 216)).toBe('left');
    // Far right, vertically centered.
    expect(pickDropZone(rect, barHeight, 295, 216)).toBe('right');
    // Horizontally centered, near top of content area (just below tabbar).
    expect(pickDropZone(rect, barHeight, 200, 140)).toBe('top');
    // Horizontally centered, near bottom.
    expect(pickDropZone(rect, barHeight, 200, 295)).toBe('bottom');
  });

  it('picks the nearest edge in a corner region', () => {
    // Near the top-left corner of the content area, but closer to the left
    // edge than the top edge: x=(110-100)/200=0.05, y=(142-32-100)/168≈0.0595.
    // distX (0.05) < distY (0.0595) -> 'left' wins over 'top'.
    expect(pickDropZone(rect, barHeight, 110, 142)).toBe('left');
  });
});

describe('pickDropIndex', () => {
  const rects: PaneRect[] = [
    { left: 0, top: 0, width: 50, height: 20 },
    { left: 50, top: 0, width: 50, height: 20 },
    { left: 100, top: 0, width: 50, height: 20 },
  ];

  it('returns 0 when the pointer is before the first tab midpoint', () => {
    expect(pickDropIndex(rects, 10)).toBe(0);
  });

  it('returns the index of the tab whose midpoint the pointer is left of', () => {
    // second tab midpoint = 75
    expect(pickDropIndex(rects, 60)).toBe(1);
  });

  it('returns array length when the pointer is past every midpoint', () => {
    expect(pickDropIndex(rects, 200)).toBe(3);
  });

  it('returns 0 for an empty array', () => {
    expect(pickDropIndex([], 100)).toBe(0);
  });
});

describe('clampRatioForMinSizes', () => {
  it('leaves an in-range ratio untouched when min-size constraints are satisfied', () => {
    // container 1000px, splitter 4px, minPane 160px each side -> minRatio ~0.16, maxRatio ~0.84
    expect(clampRatioForMinSizes(1000, 4, 160, 160, 0.5)).toBe(0.5);
  });

  it('clamps to the min-size boundary when tighter than the 0.15-0.85 default', () => {
    // container 500px, splitter 4px, minA 160px -> available 496px
    // minRatio = 160/496 ≈ 0.3226 (tighter than the 0.15 hard floor)
    const clamped = clampRatioForMinSizes(500, 4, 160, 160, 0.1);
    expect(clamped).toBeCloseTo(160 / 496, 5);
  });

  it('prefers the 0.15-0.85 hard bounds when they are tighter than the min-size constraint', () => {
    // container 4000px, splitter 4px, minPane 160px each side -> minRatio ~0.04,
    // which is looser than the hard floor 0.15, so 0.15 wins.
    const clamped = clampRatioForMinSizes(4000, 4, 160, 160, 0.05);
    expect(clamped).toBe(0.15);
  });

  it('falls back to 0.5 when both sides cannot fit their minimums simultaneously', () => {
    expect(clampRatioForMinSizes(300, 4, 160, 160, 0.5)).toBe(0.5);
  });

  it('supports asymmetric minimums (e.g. one side is a nested split needing more room)', () => {
    // container 1000px, splitter 4px, side a needs 340px (a nested split), side b needs 160px.
    // available = 996px; minRatio = 340/996 ≈ 0.3414; maxRatio = 1 - 160/996 ≈ 0.8394.
    const clamped = clampRatioForMinSizes(1000, 4, 340, 160, 0.1);
    expect(clamped).toBeCloseTo(340 / 996, 5);

    const clampedHigh = clampRatioForMinSizes(1000, 4, 340, 160, 0.95);
    expect(clampedHigh).toBeCloseTo(1 - 160 / 996, 5);
  });
});

describe('subtreeMinSizePx', () => {
  const pane = (id: string): PaneNode => ({ type: 'pane', id, tabIds: [], activeTabId: null });

  it('returns minPanePx for a leaf pane', () => {
    expect(subtreeMinSizePx(pane('p1'), 'row', 160, 4)).toBe(160);
  });

  it('sums both sides plus the splitter for a split matching the resize axis', () => {
    const node: SplitNode = { type: 'split', dir: 'row', ratio: 0.5, a: pane('p1'), b: pane('p2') };
    // Same-axis split: 160 + 160 + splitter(4) = 324.
    expect(subtreeMinSizePx(node, 'row', 160, 4)).toBe(324);
  });

  it('takes the max of both sides for a split orthogonal to the resize axis', () => {
    const node: SplitNode = { type: 'split', dir: 'col', ratio: 0.5, a: pane('p1'), b: pane('p2') };
    // Orthogonal split: stacked across the row axis, so it only needs one pane's width.
    expect(subtreeMinSizePx(node, 'row', 160, 4)).toBe(160);
  });

  it('computes the correct minimum for a nested same-axis-then-orthogonal tree', () => {
    // Outer split is 'row' (the axis being resized). Its `b` side is itself a
    // 'row' split of two panes: that nested split needs 160+160+4=324px along
    // the row axis, not just 160px for "one pane".
    const nestedRowSplit: SplitNode = { type: 'split', dir: 'row', ratio: 0.5, a: pane('p2'), b: pane('p3') };
    const outer: LayoutNode = { type: 'split', dir: 'row', ratio: 0.5, a: pane('p1'), b: nestedRowSplit };
    expect(subtreeMinSizePx(outer, 'row', 160, 4)).toBe(160 + 324 + 4);
  });

  it('computes the correct minimum for a nested orthogonal-then-same-axis tree', () => {
    // Outer split is 'row'. Its `b` side is a 'col' split (orthogonal to the
    // resize axis) of two panes -> along the row axis it only needs 160px
    // (the wider of its two orthogonal children, both single panes).
    const nestedColSplit: SplitNode = { type: 'split', dir: 'col', ratio: 0.5, a: pane('p2'), b: pane('p3') };
    const outer: LayoutNode = { type: 'split', dir: 'row', ratio: 0.5, a: pane('p1'), b: nestedColSplit };
    expect(subtreeMinSizePx(outer, 'row', 160, 4)).toBe(160 + 160 + 4);
  });
});

describe('clampRatioForMinSizes protects nested split minimums (integration-style)', () => {
  it('prevents an outer row split from shrinking a nested row split below its descendants minimum', () => {
    // Regression for the reported bug: outer row split's `b` side is itself a
    // row split of two panes. Naively clamping with minBPx=160 (one pane) would
    // let the outer ratio go up to 1 - 160/available, squeezing the nested
    // panes to ~78px each. Using subtreeMinSizePx's 324px for `b` prevents that.
    const nestedRowSplit: SplitNode = { type: 'split', dir: 'row', ratio: 0.5, a: pane('p2'), b: pane('p3') };
    const outer: SplitNode = { type: 'split', dir: 'row', ratio: 0.5, a: pane('p1'), b: nestedRowSplit };

    const containerPx = 500;
    const splitterPx = 4;
    const minPanePx = 160;
    const minA = subtreeMinSizePx(outer.a, 'row', minPanePx, splitterPx);
    const minB = subtreeMinSizePx(outer.b, 'row', minPanePx, splitterPx);
    expect(minB).toBe(324);

    // Attempt to shrink `a` down to almost nothing (ratio near 0), which would
    // otherwise blow past `b`'s real minimum.
    const clamped = clampRatioForMinSizes(containerPx, splitterPx, minA, minB, 0.01);
    const available = containerPx - splitterPx;
    const bWidthPx = (1 - clamped) * available;
    expect(bWidthPx).toBeGreaterThanOrEqual(minB - 0.001);
  });

  function pane(id: string): PaneNode {
    return { type: 'pane', id, tabIds: [], activeTabId: null };
  }
});
