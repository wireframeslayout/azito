import { describe, expect, it } from 'vitest';
import { storageRelativeKey } from './storageKey';

describe('storageRelativeKey', () => {
  it('retains folders and keeps files with the same name distinct', () => {
    expect(storageRelativeKey(1, 'projects/1/a/file.md')).toBe('a/file.md');
    expect(storageRelativeKey(1, 'projects/1/b/file.md')).toBe('b/file.md');
    expect(() => storageRelativeKey(1, 'projects/2/a/file.md')).toThrow();
  });
});
