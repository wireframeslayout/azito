import { describe, expect, it } from 'vitest';
import { lineDiff } from './lineDiff';

describe('lineDiff', () => {
  it('shows unchanged, removed and added lines', () => {
    expect(lineDiff('a\nb', 'a\nc')).toEqual([{ kind: 'same', text: 'a' }, { kind: 'removed', text: 'b' }, { kind: 'added', text: 'c' }]);
  });
  it('stops before the line and calculation limits', () => {
    expect(lineDiff('x\n'.repeat(20_000), '')).toBeNull();
    expect(lineDiff('x\n'.repeat(1_000), 'y\n'.repeat(1_000))).toBeNull();
  });
});
