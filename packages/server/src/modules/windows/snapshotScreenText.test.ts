import { describe, expect, it } from 'vitest';
import { snapshotScreenText } from './snapshotScreenText';

describe('snapshotScreenText', () => {
  it('removes control sequences and bottom padding while preserving icons and internal blanks', () => {
    expect(snapshotScreenText('\x1b[31mone\x1b[0m\n\n😀 \uE001\n  \n', 3)).toBe('one\n\n😀 \uE001');
  });
  it('limits lines and handles an empty screen', () => {
    expect(snapshotScreenText('one\ntwo\nthree\n', 2)).toBe('two\nthree');
    expect(snapshotScreenText(' \n\n', 12)).toBe('');
  });
});
