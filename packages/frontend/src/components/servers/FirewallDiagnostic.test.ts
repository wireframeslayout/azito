import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FirewallDiagnostic } from './FirewallDiagnostic';

describe('FirewallDiagnostic', () => {
  it('shows the diagnosis, profile and time', () => {
    const checkedAt = Date.parse('2026-01-01T00:00:00Z');
    const html = renderToStaticMarkup(createElement(FirewallDiagnostic, { diagnostic: { state: 'blocked', detail: 'Inspect rule', checkedAt, networkCategory: 'Public' } }));
    expect(html).toContain('Inspect rule');
    expect(html).toContain('Public');
    expect(html).toContain(new Date(checkedAt).toLocaleString());
  });
});
