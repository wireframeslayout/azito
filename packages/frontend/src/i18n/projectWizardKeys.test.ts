import { describe, it, expect } from 'vitest';
import enProjects from './locales/en/projects.json';
import jaProjects from './locales/ja/projects.json';

// The project-creation/add-environment wizard's i18n keys (`wizard.*`) must
// exist in both locales with identical shape — a key present in one but
// missing in the other silently falls back to i18next's raw-key rendering
// in whichever locale lacks it (see repoDiscoverySummary.test.ts for the
// same class of regression on a different key).

function collectKeyPaths(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [prefix];
  const entries = Object.entries(obj as Record<string, unknown>);
  return entries.flatMap(([key, value]) => collectKeyPaths(value, prefix ? `${prefix}.${key}` : key));
}

describe('project wizard i18n keys (ja/en parity)', () => {
  it('has a "wizard" namespace in both locales', () => {
    expect(jaProjects).toHaveProperty('wizard');
    expect(enProjects).toHaveProperty('wizard');
  });

  it('has an identical set of wizard.* key paths in ja and en', () => {
    const jaKeys = collectKeyPaths((jaProjects as Record<string, unknown>).wizard).sort();
    const enKeys = collectKeyPaths((enProjects as Record<string, unknown>).wizard).sort();
    expect(jaKeys).toEqual(enKeys);
    // Sanity check the collector actually walked something (a silently
    // empty `wizard: {}` in both files would otherwise pass the equality
    // check above vacuously).
    expect(jaKeys.length).toBeGreaterThan(10);
  });

  it('has no empty string values (a placeholder key left untranslated)', () => {
    for (const [lng, resources] of [['ja', jaProjects], ['en', enProjects]] as const) {
      const wizard = (resources as Record<string, unknown>).wizard;
      const values = collectKeyPaths(wizard).map((path) => {
        return path.split('.').reduce<unknown>((node, segment) => (node as Record<string, unknown>)?.[segment], wizard);
      });
      for (const v of values) {
        expect(typeof v === 'string' && v.trim().length > 0, `${lng}: empty wizard string value`).toBe(true);
      }
    }
  });
});
