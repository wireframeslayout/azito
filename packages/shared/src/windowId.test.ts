import { describe, it, expect } from 'vitest';
import { formatWindowId, isInternalWindowName } from './windowId';

describe('formatWindowId', () => {
  it('formats a window id with W- prefix', () => {
    expect(formatWindowId(123)).toBe('W-123');
  });
});

describe('isInternalWindowName', () => {
  it('matches win--xxxx pattern', () => {
    expect(isInternalWindowName('win--6t61')).toBe(true);
  });

  it('matches task-NNN--xxxx pattern', () => {
    expect(isInternalWindowName('task-231--x9oh')).toBe(true);
  });

  it('rejects human-readable names', () => {
    expect(isInternalWindowName('build server')).toBe(false);
  });

  it('rejects short names like main', () => {
    expect(isInternalWindowName('main')).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isInternalWindowName(undefined)).toBe(false);
  });

  it('returns false for null', () => {
    expect(isInternalWindowName(null)).toBe(false);
  });
});
