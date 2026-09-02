import { describe, it, expect } from 'vitest';
import { createInstance } from 'i18next';
import enProjects from './locales/en/projects.json';
import jaProjects from './locales/ja/projects.json';

/**
 * Regression test for the RepoDiscoveryDialog summary line.
 *
 * Round 1 (Issue #19 review, Minor finding): `t('settings.repositories.discover.summary',
 * { repoCount, remoteCount })` was called without i18next's reserved
 * `count` variable, so neither a `_one` nor a `_other` plural variant could
 * ever be selected — i18next fell back to the untranslated key name itself,
 * literally rendering the string
 * "settings.repositories.discover.summary" in the UI.
 *
 * Round 2 (later review, Minor finding): the fix collapsed to a single
 * non-pluralized `summary` string built from two independent counts
 * (repos, remotes). English needs each count pluralized independently
 * ("1 repository" vs "3 repositories"), and i18next's `_one`/`_other`
 * suffix mechanism can only ever drive ONE `count` per key — so a single
 * `summary_one`/`summary_other` pair cannot represent all four
 * singular/plural combinations of (repoCount, remoteCount) at once. The
 * fix now renders `repoCount` and `remoteCount` as two independently
 * pluralized labels and composes them via a non-pluralized `summary`
 * template. This spins up a real i18next instance against the actual
 * shipped locale JSON (not a mock), the same way `RepoDiscoveryDialog`
 * calls `t()`, and exercises every 1/1, 1/many, many/1, many/many
 * combination so a regression to a single pluralized key is caught here
 * rather than only by visual inspection.
 */
function renderSummary(i18n: ReturnType<typeof createInstance>, repoCount: number, remoteCount: number): string {
  const repos = i18n.t('settings.repositories.discover.repoCount', { count: repoCount });
  const remotes = i18n.t('settings.repositories.discover.remoteCount', { count: remoteCount });
  return i18n.t('settings.repositories.discover.summary', { repos, remotes });
}

describe('RepoDiscoveryDialog summary key', () => {
  for (const [lng, resources] of [
    ['en', enProjects],
    ['ja', jaProjects],
  ] as const) {
    describe(lng, () => {
      const combinations: Array<[number, number]> = [
        [1, 1],
        [1, 5],
        [3, 1],
        [3, 5],
      ];

      for (const [repoCount, remoteCount] of combinations) {
        it(`renders the discover summary for ${repoCount} repositories / ${remoteCount} remotes`, async () => {
          const i18n = createInstance();
          await i18n.init({
            lng,
            fallbackLng: lng,
            resources: { [lng]: { projects: resources } },
            defaultNS: 'projects',
            interpolation: { escapeValue: false },
          });

          const rendered = renderSummary(i18n, repoCount, remoteCount);

          // Must not fall back to a raw key and must not leak an
          // unresolved `{{...}}` placeholder.
          expect(rendered).not.toContain('settings.repositories.discover');
          expect(rendered).not.toContain('{{');
          expect(rendered).toContain(String(repoCount));
          expect(rendered).toContain(String(remoteCount));
        });
      }

      if (lng === 'en') {
        it('pluralizes "repository" vs "repositories" and "remote" vs "remotes" independently', async () => {
          const i18n = createInstance();
          await i18n.init({
            lng,
            fallbackLng: lng,
            resources: { [lng]: { projects: resources } },
            defaultNS: 'projects',
            interpolation: { escapeValue: false },
          });

          expect(renderSummary(i18n, 1, 5)).toBe('1 repository, 5 remotes');
          expect(renderSummary(i18n, 3, 1)).toBe('3 repositories, 1 remote');
          expect(renderSummary(i18n, 1, 1)).toBe('1 repository, 1 remote');
          expect(renderSummary(i18n, 3, 5)).toBe('3 repositories, 5 remotes');
        });
      }
    });
  }
});
