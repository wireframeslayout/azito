import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FileSidebarHeader } from './FileSidebarHeader';

const noop = (): void => {};
const REASON = 'Not available yet for Windows agents';

function render(): string {
  return renderToStaticMarkup(createElement(FileSidebarHeader, { onSearch: noop, onDiff: noop, onRefresh: noop, searchActive: false, serverCount: 1 }));
}

describe('FileSidebarHeader where the diff view is closed (git on a Windows agent)', () => {
  const html = renderToStaticMarkup(createElement(FileSidebarHeader, {
    onSearch: noop, onDiff: noop, onRefresh: noop, searchActive: false, serverCount: 1,
    diffBlockedReason: REASON, diffBlockedReasonId: 'git-reason',
  }));

  it('keeps the diff button focusable (aria-disabled), tied to the notice, with the reason as its title', () => {
    expect(html).toContain('aria-describedby="git-reason"');
    expect(html).toContain(`title="${REASON}"`);
    expect(html.match(/aria-disabled/g)).toHaveLength(1);
    expect(html).not.toMatch(/\sdisabled(=|\s|>)/);
  });
});

describe('FileSidebarHeader where nothing is closed (Linux / macOS)', () => {
  it('has no disabled state and no description', () => {
    const html = render();
    expect(html).not.toContain('aria-disabled');
    expect(html).not.toContain('aria-describedby');
    expect(html).not.toContain(REASON);
  });
});
