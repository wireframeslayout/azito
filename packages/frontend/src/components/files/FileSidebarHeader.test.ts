import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FileSidebarHeader } from './FileSidebarHeader';

const noop = (): void => {};
const REASON = 'Not available yet for Windows agents';

function render(extra: { searchBlockedReason?: string | null; searchBlockedReasonId?: string }): string {
  return renderToStaticMarkup(createElement(FileSidebarHeader, { onSearch: noop, onDiff: noop, onRefresh: noop, searchActive: false, serverCount: 1, ...extra }));
}

describe('FileSidebarHeader where file search is closed (a Windows agent)', () => {
  const html = render({ searchBlockedReason: REASON, searchBlockedReasonId: 'search-reason' });

  it('keeps the search button focusable (aria-disabled), tied to the notice that explains it', () => {
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('aria-describedby="search-reason"');
    expect(html).toContain(`title="${REASON}"`);
  });

  it('leaves the file operations open: no button is disabled, diff and refresh work', () => {
    expect(html).not.toMatch(/\sdisabled(=|\s|>)/);
    expect(html.match(/aria-disabled/g)).toHaveLength(1);
  });
});

describe('FileSidebarHeader where nothing is closed (Linux / macOS)', () => {
  it('has no disabled state and no description', () => {
    const html = render({});
    expect(html).not.toContain('aria-disabled');
    expect(html).not.toContain('aria-describedby');
    expect(html).not.toContain(REASON);
  });
});
