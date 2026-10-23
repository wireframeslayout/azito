import { describe, it, expect } from 'vitest';
import { getDistanceFromBottom, isNearBottom, nextNearBottom, NEAR_BOTTOM_THRESHOLD_PX } from './scrollFollow';

describe('isNearBottom', () => {
  it('treats the exact bottom as near', () => {
    expect(isNearBottom({ scrollTop: 1200, scrollHeight: 2000, clientHeight: 800 })).toBe(true);
  });
  it('is near just inside the threshold and not near at the threshold', () => {
    expect(isNearBottom({ scrollTop: 1200 - (NEAR_BOTTOM_THRESHOLD_PX - 1), scrollHeight: 2000, clientHeight: 800 })).toBe(true);
    expect(isNearBottom({ scrollTop: 1200 - NEAR_BOTTOM_THRESHOLD_PX, scrollHeight: 2000, clientHeight: 800 })).toBe(false);
  });
  it('treats content shorter than the viewport as near', () => {
    expect(getDistanceFromBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 800 })).toBeLessThan(0);
    expect(isNearBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 800 })).toBe(true);
  });
});

describe('nextNearBottom', () => {
  it('returns true when near the bottom', () => {
    expect(nextNearBottom(false, 1000, { scrollTop: 1200, scrollHeight: 2000, clientHeight: 800 })).toBe(true);
  });
  it('preserves prevNear when distance opened but scrollTop increased', () => {
    expect(nextNearBottom(true, 800, { scrollTop: 900, scrollHeight: 3000, clientHeight: 800 })).toBe(true);
  });
  it('preserves prevNear when distance opened but scrollTop unchanged', () => {
    expect(nextNearBottom(true, 900, { scrollTop: 900, scrollHeight: 3000, clientHeight: 800 })).toBe(true);
  });
  it('returns false when scrollTop decreased and far from bottom', () => {
    expect(nextNearBottom(true, 1000, { scrollTop: 800, scrollHeight: 3000, clientHeight: 800 })).toBe(false);
  });
});
