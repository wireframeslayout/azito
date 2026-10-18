import { describe, it, expect } from 'vitest';
import { getDistanceFromBottom, isNearBottom, NEAR_BOTTOM_THRESHOLD_PX } from './scrollFollow';

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
