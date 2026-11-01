import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import en from '../../i18n/locales/en/servers.json';

const OVERVIEW: Record<string, unknown> = en.overview;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      const value = OVERVIEW[key.replace(/^overview\./, '')];
      const template = typeof value === 'string' ? value : key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => params?.[name] ?? '');
    },
  }),
}));

import { FirewallDiagnostic } from './FirewallDiagnostic';

describe('FirewallDiagnostic', () => {
  it('shows the diagnosis, profile and time', () => {
    const checkedAt = Date.parse('2026-01-01T00:00:00Z');
    const html = renderToStaticMarkup(createElement(FirewallDiagnostic, { diagnostic: { state: 'blocked', detail: 'Inspect rule', checkedAt, networkCategory: 'Public' } }));
    expect(html).toContain('Inspect rule');
    expect(html).toContain('Network profile: Public');
    expect(html).toContain(new Date(checkedAt).toLocaleString());
  });

  it('says the profile is unknown when the host did not report it', () => {
    const html = renderToStaticMarkup(createElement(FirewallDiagnostic, { diagnostic: { state: 'unknown', detail: 'Not verified', checkedAt: 0, networkCategory: null } }));
    expect(html).toContain('Network profile: unknown');
  });
});
