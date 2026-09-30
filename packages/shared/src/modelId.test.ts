import { describe, it, expect } from 'vitest';
import { isValidModelId } from './modelId';

describe('isValidModelId', () => {
  it.each([
    'claude-opus-5-5',
    'claude-opus-5-5[1m]',
    'gpt-6.1-sol',
    'gpt-reserve',
    'o3',
    'codex-mini-latest',
  ])('accepts valid model ID: %s', (id) => {
    expect(isValidModelId(id)).toBe(true);
  });

  it.each([
    ['empty string', ''],
    ['shell injection', 'a;rm -rf'],
    ['command substitution', '$(x)'],
    ['whitespace', 'a b'],
    ['over 64 chars', 'a'.repeat(65)],
    ['starts with dot', '.starts-with-dot'],
    ['starts with dash', '-starts-with-dash'],
  ])('rejects invalid model ID: %s', (_label, id) => {
    expect(isValidModelId(id)).toBe(false);
  });
});
