import { describe, it, expect } from 'vitest';
import { parseWindowId, formatWindowId, isInternalWindowName, stripGeneratedSuffix } from './windowId';

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

describe('stripGeneratedSuffix', () => {
  it('strips --xxxx suffix', () => {
    expect(stripGeneratedSuffix('editor--ab12')).toBe('editor');
  });
  it('strips from win--xxxx', () => {
    expect(stripGeneratedSuffix('win--6t61')).toBe('win');
  });
  it('strips from task-231--x9oh', () => {
    expect(stripGeneratedSuffix('task-231--x9oh')).toBe('task-231');
  });
  it('returns name unchanged when no suffix', () => {
    expect(stripGeneratedSuffix('build server')).toBe('build server');
  });
  it('returns name unchanged for short names', () => {
    expect(stripGeneratedSuffix('main')).toBe('main');
  });
});

describe('parseWindowId', () => {
  it.each(['W-123', 'w-123', 'w123', '123'])('parses %s', (value) => {
    expect(parseWindowId(value)).toBe(123);
  });

  it.each(['', ' 123', '123 ', '0', '-1', '1.2', 'win--6t61', '9007199254740992'])('rejects %s', (value) => {
    expect(parseWindowId(value)).toBeNull();
  });

  it('accepts the maximum safe integer', () => {
    expect(parseWindowId('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
  });
});
