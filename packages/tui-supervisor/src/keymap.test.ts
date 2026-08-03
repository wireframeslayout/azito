import { describe, expect, it } from 'vitest';
import { mapKey } from './keymap';

describe('mapKey', () => {
  it('maps symbolic keys to terminal sequences', () => {
    expect(mapKey('Enter')).toBe('\r');
    expect(mapKey('Escape')).toBe('\x1b');
    expect(mapKey('Tab')).toBe('\t');
    expect(mapKey('C-c')).toBe('\x03');
    expect(mapKey('Up')).toBe('\x1b[A');
    expect(mapKey('Down')).toBe('\x1b[B');
  });

  it('passes unknown keys through literally', () => {
    expect(mapKey('a')).toBe('a');
    expect(mapKey('hello')).toBe('hello');
  });
});
