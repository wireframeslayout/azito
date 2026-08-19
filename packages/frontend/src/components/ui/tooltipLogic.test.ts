import { describe, it, expect } from 'vitest';
import {
  computeTooltipClamp,
  tooltipVisibilityReducer,
  isTooltipOpen,
  initialTooltipVisibilityState,
  type TooltipVisibilityState,
} from './tooltipLogic';

describe('computeTooltipClamp', () => {
  it('applies no horizontal shift when the tooltip fits within the viewport', () => {
    const result = computeTooltipClamp({
      tooltipLeft: 100,
      tooltipRight: 300,
      tooltipBottom: 200,
      tooltipHeight: 60,
      triggerTop: 100,
      viewportWidth: 1024,
      viewportHeight: 768,
    });
    expect(result.shiftX).toBe(0);
    expect(result.flipToTop).toBe(false);
  });

  it('shifts right when the tooltip overflows the left edge', () => {
    // Trigger near x=0: centered tooltip left edge goes negative.
    const result = computeTooltipClamp({
      tooltipLeft: -40,
      tooltipRight: 200,
      tooltipBottom: 200,
      tooltipHeight: 60,
      triggerTop: 100,
      viewportWidth: 1024,
      viewportHeight: 768,
    });
    // margin(8) - (-40) = 48
    expect(result.shiftX).toBe(48);
  });

  it('shifts left when the tooltip overflows the right edge (mobile toolbar case)', () => {
    // Small viewport (375px, mobile), trigger near the right edge.
    const result = computeTooltipClamp({
      tooltipLeft: 250,
      tooltipRight: 410,
      tooltipBottom: 200,
      tooltipHeight: 60,
      triggerTop: 100,
      viewportWidth: 375,
      viewportHeight: 700,
    });
    // (375 - 8) - 410 = -43
    expect(result.shiftX).toBe(-43);
  });

  it('does not shift horizontally when exactly at the margin boundary', () => {
    const result = computeTooltipClamp({
      tooltipLeft: 8,
      tooltipRight: 367,
      tooltipBottom: 200,
      tooltipHeight: 60,
      triggerTop: 100,
      viewportWidth: 375,
      viewportHeight: 700,
    });
    expect(result.shiftX).toBe(0);
  });

  it('respects a custom margin', () => {
    const result = computeTooltipClamp({
      tooltipLeft: 10,
      tooltipRight: 200,
      tooltipBottom: 200,
      tooltipHeight: 60,
      triggerTop: 100,
      viewportWidth: 1024,
      viewportHeight: 768,
      margin: 16,
    });
    // margin(16) - 10 = 6
    expect(result.shiftX).toBe(6);
  });

  it('flips to top when the tooltip overflows the bottom edge and there is room above', () => {
    const result = computeTooltipClamp({
      tooltipLeft: 100,
      tooltipRight: 300,
      tooltipBottom: 780,
      tooltipHeight: 60,
      triggerTop: 700,
      viewportWidth: 1024,
      viewportHeight: 768,
    });
    expect(result.flipToTop).toBe(true);
  });

  it('does not flip when there is not enough room above either', () => {
    const result = computeTooltipClamp({
      tooltipLeft: 100,
      tooltipRight: 300,
      tooltipBottom: 780,
      tooltipHeight: 60,
      triggerTop: 20, // only 20px above the trigger — a 60px tooltip does not fit
      viewportWidth: 1024,
      viewportHeight: 768,
    });
    expect(result.flipToTop).toBe(false);
  });

  it('does not flip when the tooltip fits within the bottom edge', () => {
    const result = computeTooltipClamp({
      tooltipLeft: 100,
      tooltipRight: 300,
      tooltipBottom: 760,
      tooltipHeight: 60,
      triggerTop: 700,
      viewportWidth: 1024,
      viewportHeight: 768,
    });
    expect(result.flipToTop).toBe(false);
  });

  it('applies both a horizontal shift and a vertical flip simultaneously', () => {
    const result = computeTooltipClamp({
      tooltipLeft: -20,
      tooltipRight: 300,
      tooltipBottom: 780,
      tooltipHeight: 60,
      triggerTop: 700,
      viewportWidth: 1024,
      viewportHeight: 768,
    });
    expect(result.shiftX).toBe(28);
    expect(result.flipToTop).toBe(true);
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
