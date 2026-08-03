import { describe, it, expect } from 'vitest';
import { computeTabOverlayStyle } from './paneTabOverlay';
import type { PaneRect } from '../../hooks/usePaneRects';

const RECT: PaneRect = { top: 10, left: 20, width: 300, height: 200 };

describe('computeTabOverlayStyle', () => {
  it('positions and sizes the wrapper to exactly cover a measured rect', () => {
    const style = computeTabOverlayStyle(RECT, true, true);
    expect(style.position).toBe('absolute');
    expect(style.top).toBe(10);
    expect(style.left).toBe(20);
    expect(style.width).toBe(300);
    expect(style.height).toBe(200);
    expect(style.overflow).toBe('hidden');
  });

  it('is visible and interactive for the pane\'s active tab when interactive', () => {
    const style = computeTabOverlayStyle(RECT, true, true);
    expect(style.visibility).toBe('visible');
    expect(style.pointerEvents).toBe('auto');
  });

  it('stays visible but non-interactive when the active tab is not currently interactive (e.g. mid pane-drag)', () => {
    const style = computeTabOverlayStyle(RECT, true, false);
    expect(style.visibility).toBe('visible');
    expect(style.pointerEvents).toBe('none');
  });

  it('is hidden and non-interactive for a tab that is not its pane\'s active tab, even with a measured rect', () => {
    const style = computeTabOverlayStyle(RECT, false, false);
    expect(style.visibility).toBe('hidden');
    expect(style.pointerEvents).toBe('none');
  });

  // Regression test for the actual reported bug: a pane that hasn't been measured yet (e.g.
  // the instant it's created by a tab-drag split, before usePaneRects's observer reports
  // its rect) must render fully hidden/non-interactive — *unconditionally*, even though the
  // tab is (or is about to become) its pane's active tab and would otherwise be interactive.
  // Previously, `visibility: tabVisible ? 'visible' : 'hidden'` was applied *after* (and so
  // overrode) the `!rect` fallback's `visibility: 'hidden'`, letting an unmeasured pane's
  // content render/overflow at the container's (0,0) origin with pointerEvents: 'auto' —
  // intercepting clicks and drags meant for whichever pane actually occupies that corner.
  it('stays fully hidden and non-interactive when unmeasured (no rect yet), even for the active/interactive tab', () => {
    const style = computeTabOverlayStyle(undefined, true, true);
    expect(style.visibility).toBe('hidden');
    expect(style.pointerEvents).toBe('none');
    expect(style.width).toBe(0);
    expect(style.height).toBe(0);
  });

  it('also stays hidden when unmeasured and not the active tab', () => {
    const style = computeTabOverlayStyle(undefined, false, false);
    expect(style.visibility).toBe('hidden');
    expect(style.pointerEvents).toBe('none');
  });
});
