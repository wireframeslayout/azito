import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FileSidebarHeader } from './FileSidebarHeader';

const noop = (): void => {};
const REASON = 'Not available yet for Windows agents';

function render(extra: { filesBlockedReason?: string | null; gitBlockedReason?: string | null }): string {
  return renderToStaticMarkup(createElement(FileSidebarHeader, { onSearch: noop, onDiff: noop, onRefresh: noop, searchActive: false, serverCount: 1, ...extra }));
}

describe('FileSidebarHeader on a host where files and version control are closed', () => {
  it('disables search, diff and refresh and says why in each tooltip', () => {
    const html = render({ filesBlockedReason: REASON, gitBlockedReason: REASON });
    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(html.match(new RegExp(`title="${REASON}"`, 'g'))).toHaveLength(3);
  });

  it('leaves every button enabled when nothing is closed (Linux / macOS)', () => {
    const html = render({});
    expect(html).not.toContain('disabled');
    expect(html).not.toContain(REASON);
  });

  it('closes only the diff when only version control is closed', () => {
    const html = render({ gitBlockedReason: REASON });
    expect(html.match(/disabled=""/g)).toHaveLength(1);
  });
});
