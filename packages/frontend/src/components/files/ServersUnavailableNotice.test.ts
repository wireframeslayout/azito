import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ServersUnavailableNotice } from './ServersUnavailableNotice';

const render = (retrying: boolean): string =>
  renderToStaticMarkup(createElement(ServersUnavailableNotice, {
    message: 'Could not load servers: HTTP 502', retryLabel: 'Retry', retryingLabel: 'Retrying...', onRetry: () => {}, retrying,
  }));

describe('ServersUnavailableNotice', () => {
  it('says why in a status region and offers the retry', () => {
    const html = render(false);
    expect(html).toContain('role="status"');
    expect(html).toContain('Could not load servers: HTTP 502');
    expect(html).toContain('Retry');
    expect(html).not.toMatch(/\sdisabled(=|\s|>)/);
  });

  it('shows the retry as running, and disabled, while one is in progress', () => {
    const html = render(true);
    expect(html).toContain('Retrying...');
    expect(html).toMatch(/\sdisabled(=|\s|>)/);
  });
});
