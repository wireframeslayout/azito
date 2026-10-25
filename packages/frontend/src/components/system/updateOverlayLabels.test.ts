import { describe, it, expect } from 'vitest';
import enSettings from '../../i18n/locales/en/settings.json';
import jaSettings from '../../i18n/locales/ja/settings.json';
import { STEP_LABEL_KEYS, formatUpdateVersion } from './updateOverlayLabels';

function lookup(tree: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((node, part) => {
    if (node === null || typeof node !== 'object') return undefined;
    return (node as Record<string, unknown>)[part];
  }, tree);
}

describe('update overlay step labels', () => {
  it.each([
    ['ja', jaSettings],
    ['en', enSettings],
  ])('translates every step in %s', (_locale, tree) => {
    const keys = Object.values(STEP_LABEL_KEYS);
    expect(keys).toHaveLength(7);
    for (const key of keys) {
      const value = lookup(tree, key);
      expect(typeof value, key).toBe('string');
      expect((value as string).length, key).toBeGreaterThan(0);
    }
  });
});

describe('formatUpdateVersion', () => {
  it.each(['v0.11.12', 'v0.12.0-rc.1', 'v0.0.0-ci.a'])('shows %s whole', (tag) => {
    expect(formatUpdateVersion(tag)).toBe(tag);
  });
});
