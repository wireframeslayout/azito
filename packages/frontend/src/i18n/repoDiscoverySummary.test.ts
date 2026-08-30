import { describe, it, expect } from 'vitest';
import { createInstance } from 'i18next';
import enProjects from './locales/en/projects.json';
import jaProjects from './locales/ja/projects.json';

/**
 * Regression test for the RepoDiscoveryDialog summary line (Issue #19
 * review round, Minor finding): `t('settings.repositories.discover.summary',
 * { repoCount, remoteCount })` was called without i18next's reserved
 * `count` variable, so neither a `_one` nor a `_other` plural variant could
 * ever be selected — i18next fell back to the untranslated key name itself,
 * literally rendering the string
 * "settings.repositories.discover.summary" in the UI.
 *
 * This spins up a real i18next instance against the actual shipped locale
 * JSON (not a mock), the same way `RepoDiscoveryDialog` calls `t()`, so a
 * regression back to a `_one`/`_other` plural key (which cannot be driven
 * by two independent counts at once) is caught here rather than only by
 * visual inspection.
 */
describe('RepoDiscoveryDialog summary key', () => {
  for (const [lng, resources] of [
    ['en', enProjects],
    ['ja', jaProjects],
  ] as const) {
    it(`renders the discover summary with both counts interpolated (${lng})`, async () => {
      const i18n = createInstance();
      await i18n.init({
        lng,
        fallbackLng: lng,
        resources: { [lng]: { projects: resources } },
        defaultNS: 'projects',
        interpolation: { escapeValue: false },
      });

      const rendered = i18n.t('settings.repositories.discover.summary', {
        repoCount: 3,
        remoteCount: 5,
      });

      // Must not fall back to the raw key (the exact bug this test guards
      // against) and must not leak an unresolved `{{...}}` placeholder.
      expect(rendered).not.toBe('settings.repositories.discover.summary');
      expect(rendered).not.toContain('{{');
      expect(rendered).toContain('3');
      expect(rendered).toContain('5');
    });
  }
});
