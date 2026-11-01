import { describe, expect, it } from 'vitest';
import { createChordMatcher } from './chordMatcher';
import { parseKeySpec } from './keySpec';
const event = (key: string, repeat = false): KeyboardEvent => ({ key, repeat, isComposing: false, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }) as KeyboardEvent;
describe('chord matching', () => {
  it('matches within the interval', () => { const m = createChordMatcher(parseKeySpec('Space Space'), 300); expect(m.feed(event(' '), 0)).toBe('pending'); expect(m.feed(event(' '), 299)).toBe('matched'); });
  it('restarts after a timeout', () => { const m = createChordMatcher(parseKeySpec('Space Space'), 300); m.feed(event(' '), 0); expect(m.feed(event(' '), 301)).toBe('pending'); expect(m.feed(event(' '), 302)).toBe('matched'); });
  it('resets after another key and ignores repeat', () => { const m = createChordMatcher(parseKeySpec('Space Space'), 300); m.feed(event(' '), 0); expect(m.feed(event(' ' , true), 1)).toBe('none'); expect(m.feed(event('x'), 2)).toBe('none'); expect(m.feed(event(' '), 3)).toBe('pending'); });
});
