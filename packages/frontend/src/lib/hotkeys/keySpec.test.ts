import { describe, expect, it } from 'vitest';
import { formatKeySpec, parseKeySpec, stepMatches } from './keySpec';
describe('key specifications', () => {
  it.each(['Ctrl+Shift+M', 'Space Space'])('round trips %s', value => expect(formatKeySpec(parseKeySpec(value))).toBe(value));
  it.each(['', 'Ctrl+', 'Ctrl+Ctrl+K', 'Ctrl+Bad', 'Banana'])('rejects %s', value => expect(() => parseKeySpec(value)).toThrow());
  it('matches Meta as Ctrl', () => expect(stepMatches(parseKeySpec('Ctrl+K').steps[0], { key: 'k', ctrlKey: false, metaKey: true, shiftKey: false, altKey: false })).toBe(true));
});
