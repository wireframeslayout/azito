import { describe, expect, it } from 'vitest';
import { encodeMisaoKey } from './misaoKeys';

describe('encodeMisaoKey', () => {
  it.each([
    ['Enter', '\r'],
    ['Escape', '\x1b'],
    ['Tab', '\t'],
    ['Space', ' '],
    ['BSpace', '\x7f'],
    ['Up', '\x1b[A'],
    ['Down', '\x1b[B'],
    ['Left', '\x1b[D'],
    ['Right', '\x1b[C'],
    ['Home', '\x1b[H'],
    ['End', '\x1b[F'],
    ['PageUp', '\x1b[5~'],
    ['PageDown', '\x1b[6~'],
    ['C-c', '\x03'],
    ['C-d', '\x04'],
    ['C-z', '\x1a'],
    ['C-a', '\x01'],
    ['C-e', '\x05'],
    ['C-k', '\x0b'],
    ['C-l', '\x0c'],
    ['C-u', '\x15'],
    ['C-w', '\x17'],
    ['C-r', '\x12'],
    ['M-b', '\x1bb'],
    ['M-f', '\x1bf'],
  ])('%s -> bytes', (key, bytes) => {
    expect(encodeMisaoKey(key)).toBe(bytes);
  });

  it('leaves everything else to be sent literally', () => {
    for (const key of ['1', '9', 'y', 'enter', 'C-x', 'echo hi', '']) {
      expect(encodeMisaoKey(key)).toBeUndefined();
    }
  });
});
