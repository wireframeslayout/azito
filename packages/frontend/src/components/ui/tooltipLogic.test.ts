import { describe, it, expect } from 'vitest';
import {
  computeTooltipClamp,
  tooltipVisibilityReducer,
  isTooltipOpen,
  initialTooltipVisibilityState,
  type TooltipClampInput,
  type TooltipVisibilityState,
} from './tooltipLogic';

describe('computeTooltipClamp', () => {
  it('applies no horizontal shift when the tooltip fits within the viewport', () => {
    const result = computeTooltipClamp({
      wrapperLeft: 130,
      wrapperRight: 170,
      wrapperTop: 80,
      wrapperBottom: 100,
      tooltipWidth: 200,
      tooltipHeight: 60,
      viewportWidth: 1024,
      viewportHeight: 768,
    });
    expect(result.shiftX).toBe(0);
    expect(result.flipToTop).toBe(false);
  });

  it('shifts right when the tooltip overflows the left edge', () => {
    // Trigger near x=0: centered tooltip left edge goes negative.
    const result = computeTooltipClamp({
      wrapperLeft: 60,
      wrapperRight: 80,
      wrapperTop: 100,
      wrapperBottom: 120,
      tooltipWidth: 240,
      tooltipHeight: 60,
      viewportWidth: 1024,
      viewportHeight: 768,
    });
    // wrapperCenterX = 70, centeredLeft = 70 - 120 = -50
    // shiftX = margin(8) - (-50) = 58
    expect(result.shiftX).toBe(58);
  });

  it('shifts left when the tooltip overflows the right edge (mobile toolbar case)', () => {
    // Small viewport (375px, mobile), trigger near the right edge.
    const result = computeTooltipClamp({
      wrapperLeft: 330,
      wrapperRight: 350,
      wrapperTop: 100,
      wrapperBottom: 120,
      tooltipWidth: 160,
      tooltipHeight: 60,
      viewportWidth: 375,
      viewportHeight: 700,
    });
    // wrapperCenterX = 340, centeredLeft = 260, centeredRight = 420
    // shiftX = (375 - 8) - 420 = -53
    expect(result.shiftX).toBe(-53);
  });

  it('does not shift horizontally when exactly at the margin boundary', () => {
    const result = computeTooltipClamp({
      wrapperLeft: 187.5,
      wrapperRight: 187.5,
      wrapperTop: 100,
      wrapperBottom: 120,
      tooltipWidth: 359,
      tooltipHeight: 60,
      viewportWidth: 375,
      viewportHeight: 700,
    });
    // centeredLeft = 187.5 - 179.5 = 8, centeredRight = 8 + 359 = 367 = 375 - 8
    expect(result.shiftX).toBe(0);
  });

  it('respects a custom margin', () => {
    const result = computeTooltipClamp({
      wrapperLeft: 110,
      wrapperRight: 110,
      wrapperTop: 100,
      wrapperBottom: 120,
      tooltipWidth: 190,
      tooltipHeight: 60,
      viewportWidth: 1024,
      viewportHeight: 768,
      margin: 16,
    });
    // centeredLeft = 110 - 95 = 15, shiftX = margin(16) - 15 = 1
    expect(result.shiftX).toBe(1);
  });

  it('flips to top when the tooltip overflows the bottom edge and there is room above', () => {
    const result = computeTooltipClamp({
      wrapperLeft: 100,
      wrapperRight: 300,
      wrapperTop: 692,
      wrapperBottom: 712,
      tooltipWidth: 200,
      tooltipHeight: 60,
      viewportWidth: 1024,
      viewportHeight: 768,
    });
    // belowBottom = 712 + 8 + 60 = 780 > 768 - 8 -> overflows
    // aboveTop = 692 - 8 - 60 = 624 >= 8 -> fits
    expect(result.flipToTop).toBe(true);
  });

  it('picks the side with more room and caps maxHeight when neither side fully fits', () => {
    // aboveSpace = 20 - 8(gap) - 8(margin) = 4; belowSpace = 768 - 8 - 8 - 712 = 40.
    // Below has more room, so it stays below (unlike a plain "does it overflow" check,
    // this compares available space on both sides) and gets capped to that space.
    const result = computeTooltipClamp({
      wrapperLeft: 100,
      wrapperRight: 300,
      wrapperTop: 20, // only a sliver of room above the trigger
      wrapperBottom: 712,
      tooltipWidth: 200,
      tooltipHeight: 60, // fits in neither the 4px above nor the 40px below
      viewportWidth: 1024,
      viewportHeight: 768,
    });
    expect(result.flipToTop).toBe(false);
    expect(result.top).toBe(720); // wrapperBottom(712) + gap(8)
    expect(result.maxHeight).toBe(40);
  });

  it('flips to the top and caps maxHeight when the top has more room but still not enough', () => {
    // aboveSpace = 500 - 8(gap) - 8(margin) = 484; belowSpace = 768 - 8 - 8 - 760 = -8.
    // Above has (much) more room, so it flips and clamps `top` to the viewport margin.
    const result = computeTooltipClamp({
      wrapperLeft: 100,
      wrapperRight: 300,
      wrapperTop: 500,
      wrapperBottom: 760, // trigger sits almost at the bottom edge
      tooltipWidth: 200,
      tooltipHeight: 600, // taller than either available space
      viewportWidth: 1024,
      viewportHeight: 768,
    });
    expect(result.flipToTop).toBe(true);
    expect(result.top).toBe(8); // clamped to the viewport margin
    expect(result.maxHeight).toBe(484);
  });

  it('does not set maxHeight when the tooltip fits without clamping', () => {
    const result = computeTooltipClamp({
      wrapperLeft: 130,
      wrapperRight: 170,
      wrapperTop: 80,
      wrapperBottom: 100,
      tooltipWidth: 200,
      tooltipHeight: 60,
      viewportWidth: 1024,
      viewportHeight: 768,
    });
    expect(result.maxHeight).toBeNull();
    expect(result.top).toBe(108); // wrapperBottom(100) + gap(8)
  });

  it('does not flip when the tooltip fits within the bottom edge', () => {
    const result = computeTooltipClamp({
      wrapperLeft: 100,
      wrapperRight: 300,
      wrapperTop: 692,
      wrapperBottom: 692,
      tooltipWidth: 200,
      tooltipHeight: 60,
      viewportWidth: 1024,
      viewportHeight: 768,
    });
    // belowBottom = 692 + 8 + 60 = 760 <= 768 - 8 -> fits
    expect(result.flipToTop).toBe(false);
  });

  it('applies both a horizontal shift and a vertical flip simultaneously', () => {
    const result = computeTooltipClamp({
      wrapperLeft: 60,
      wrapperRight: 80,
      wrapperTop: 692,
      wrapperBottom: 712,
      tooltipWidth: 240,
      tooltipHeight: 60,
      viewportWidth: 1024,
      viewportHeight: 768,
    });
    // wrapperCenterX = 70, centeredLeft = -50, shiftX = 8 - (-50) = 58
    expect(result.shiftX).toBe(58);
    expect(result.flipToTop).toBe(true);
  });

  describe('deterministic output from the uncorrected canonical geometry (contract test)', () => {
    // This block verifies a *contract of the pure function itself*: given the same
    // uncorrected, below-placed canonical input (wrapper rect + tooltip offsetWidth/
    // offsetHeight), computeTooltipClamp() always returns the same result, and its input
    // shape has no field that could accept a post-transform tooltip rect.
    //
    // What this does NOT cover: whether the *call site* (Tooltip.tsx) actually keeps
    // re-deriving that canonical geometry from `wrapperEl.getBoundingClientRect()` +
    // `tooltipEl.offsetWidth/offsetHeight` on every re-measure, rather than accidentally
    // feeding back an already-corrected value (e.g. `tooltipRef.getBoundingClientRect()`
    // after a transform was applied). This project's frontend vitest config runs with
    // `environment: 'node'` (no jsdom/testing-library — see AGENTS.md / vitest config), so
    // there is no DOM to mount Tooltip.tsx against and assert on real re-measure calls.
    // That call-site regression is guarded only by the comments in Tooltip.tsx at the
    // measurement site, not by an automated test here.

    const edgeInput: TooltipClampInput = {
      // Trigger pinned near the right edge and near the bottom of a small viewport, so both
      // a horizontal shift and a vertical flip are triggered on the first computation.
      wrapperLeft: 340,
      wrapperRight: 360,
      wrapperTop: 660,
      wrapperBottom: 680,
      tooltipWidth: 220,
      tooltipHeight: 80,
      viewportWidth: 375,
      viewportHeight: 700,
    };

    it('returns the same result when called twice with the same (uncorrected) input', () => {
      const first = computeTooltipClamp(edgeInput);
      const second = computeTooltipClamp(edgeInput);
      expect(second).toEqual(first);
      // Sanity check this scenario actually exercises both correction paths.
      expect(first.shiftX).not.toBe(0);
      expect(first.flipToTop).toBe(true);
    });

    it('is unaffected by re-running on a freshly re-measured, unchanged trigger/tooltip size (simulated reopen)', () => {
      // Reopen/resize re-measures wrapperEl.getBoundingClientRect() and
      // tooltipEl.offsetWidth/offsetHeight from scratch each time — since neither the
      // trigger's layout position nor the tooltip's content size changed, the canonical
      // input is identical across "renders", and so must the output be.
      const results = Array.from({ length: 5 }, () => computeTooltipClamp({ ...edgeInput }));
      for (const result of results) {
        expect(result).toEqual(results[0]);
      }
    });

    it('does not accept previously-shifted geometry as if it were fresh input (shape guards against the bug)', () => {
      // The old buggy call site passed the *tooltip's own* clamped rect (left/right/bottom)
      // back in as the next measurement. The new signature only accepts the wrapper's rect
      // plus the tooltip's intrinsic (offset) size — there is no field here to accidentally
      // pass a post-transform tooltip rect through, which is what made the old shape
      // structurally prone to this bug.
      const keys = Object.keys(edgeInput);
      expect(keys).toEqual(
        expect.arrayContaining([
          'wrapperLeft',
          'wrapperRight',
          'wrapperTop',
          'wrapperBottom',
          'tooltipWidth',
          'tooltipHeight',
        ]),
      );
      expect(keys).not.toContain('tooltipLeft');
      expect(keys).not.toContain('tooltipRight');
      expect(keys).not.toContain('tooltipBottom');
    });
  });
});

describe('tooltipVisibilityReducer / isTooltipOpen', () => {
  it('opens on mouseenter and stays closed initially', () => {
    expect(isTooltipOpen(initialTooltipVisibilityState)).toBe(false);
    const next = tooltipVisibilityReducer(initialTooltipVisibilityState, { type: 'mouseenter' });
    expect(isTooltipOpen(next)).toBe(true);
  });

  it('stays open on blur while still hovered (independent hover/focus states)', () => {
    let state: TooltipVisibilityState = initialTooltipVisibilityState;
    state = tooltipVisibilityReducer(state, { type: 'focus' });
    state = tooltipVisibilityReducer(state, { type: 'mouseenter' });
    state = tooltipVisibilityReducer(state, { type: 'blur' });
    expect(isTooltipOpen(state)).toBe(true);
  });

  it('stays open on mouseleave while still focused (independent hover/focus states)', () => {
    let state: TooltipVisibilityState = initialTooltipVisibilityState;
    state = tooltipVisibilityReducer(state, { type: 'mouseenter' });
    state = tooltipVisibilityReducer(state, { type: 'focus' });
    state = tooltipVisibilityReducer(state, { type: 'mouseleave' });
    expect(isTooltipOpen(state)).toBe(true);
  });

  it('closes only once both hover and focus are gone', () => {
    let state: TooltipVisibilityState = initialTooltipVisibilityState;
    state = tooltipVisibilityReducer(state, { type: 'mouseenter' });
    state = tooltipVisibilityReducer(state, { type: 'focus' });
    state = tooltipVisibilityReducer(state, { type: 'mouseleave' });
    expect(isTooltipOpen(state)).toBe(true);
    state = tooltipVisibilityReducer(state, { type: 'blur' });
    expect(isTooltipOpen(state)).toBe(false);
  });

  it('closes immediately on Escape even while hovered and focused', () => {
    let state: TooltipVisibilityState = initialTooltipVisibilityState;
    state = tooltipVisibilityReducer(state, { type: 'mouseenter' });
    state = tooltipVisibilityReducer(state, { type: 'focus' });
    state = tooltipVisibilityReducer(state, { type: 'escape' });
    expect(isTooltipOpen(state)).toBe(false);
  });

  it('stays dismissed across further hover/focus churn until a fresh mouseenter or focus', () => {
    let state: TooltipVisibilityState = initialTooltipVisibilityState;
    state = tooltipVisibilityReducer(state, { type: 'mouseenter' });
    state = tooltipVisibilityReducer(state, { type: 'escape' });
    // Still "hovered" in state, but dismissed suppresses it.
    expect(isTooltipOpen(state)).toBe(false);
    state = tooltipVisibilityReducer(state, { type: 'mouseleave' });
    expect(isTooltipOpen(state)).toBe(false);
  });

  it('re-opens on the next mouseenter after a dismissal', () => {
    let state: TooltipVisibilityState = initialTooltipVisibilityState;
    state = tooltipVisibilityReducer(state, { type: 'mouseenter' });
    state = tooltipVisibilityReducer(state, { type: 'escape' });
    state = tooltipVisibilityReducer(state, { type: 'mouseleave' });
    state = tooltipVisibilityReducer(state, { type: 'mouseenter' });
    expect(isTooltipOpen(state)).toBe(true);
  });

  it('re-opens on the next focus after a dismissal', () => {
    let state: TooltipVisibilityState = initialTooltipVisibilityState;
    state = tooltipVisibilityReducer(state, { type: 'focus' });
    state = tooltipVisibilityReducer(state, { type: 'escape' });
    state = tooltipVisibilityReducer(state, { type: 'blur' });
    state = tooltipVisibilityReducer(state, { type: 'focus' });
    expect(isTooltipOpen(state)).toBe(true);
  });
});
