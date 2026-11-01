import { describe, expect, it } from 'vitest';
import { lineDiff } from './lineDiff';

describe('lineDiff', () => {
  it('shows unchanged, removed and added lines', () => {
    expect(lineDiff('a\nb', 'a\nc')).toEqual([{ kind: 'same', text: 'a' }, { kind: 'removed', text: 'b' }, { kind: 'added', text: 'c' }]);
  });
  it('keeps the unchanged head and tail around a change in the middle', () => {
    expect(lineDiff('a\nb\nc\nd', 'a\nx\nc\nd')).toEqual([
      { kind: 'same', text: 'a' }, { kind: 'removed', text: 'b' }, { kind: 'added', text: 'x' }, { kind: 'same', text: 'c' }, { kind: 'same', text: 'd' },
    ]);
  });
  it('compares a large file with a small change', () => {
    const lines = Array.from({ length: 10_000 }, (_, index) => `line ${index}`);
    const edited = [...lines];
    edited[5_000] = 'changed';
    const result = lineDiff(lines.join('\n'), edited.join('\n'));
    expect(result?.filter((line) => line.kind !== 'same')).toEqual([{ kind: 'removed', text: 'line 5000' }, { kind: 'added', text: 'changed' }]);
    expect(result).toHaveLength(10_001);
  });
  it('stops before the line and calculation limits', () => {
    expect(lineDiff('x\n'.repeat(20_000), '')).toBeNull();
    expect(lineDiff('x\n'.repeat(1_001), 'y\n'.repeat(1_001))).toBeNull();
  });
});
