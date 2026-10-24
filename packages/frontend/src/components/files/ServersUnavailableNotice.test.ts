import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ServersUnavailableNotice } from './ServersUnavailableNotice';

const render = (retrying: boolean): string =>
  renderToStaticMarkup(createElement(ServersUnavailableNotice, { message: 'Could not load servers: 502', retryLabel: 'Retry', onRetry: () => {}, retrying }));

describe('ServersUnavailableNotice', () => {
  it('says why in a status region and offers the retry', () => {
    const html = render(false);
    expect(html).toContain('role="status"');
    expect(html).toContain('Could not load servers: 502');
    expect(html).toContain('Retry');
    expect(html).not.toMatch(/\sdisabled(=|\s|>)/);
  });

  it('disables the retry while one is running', () => {
    expect(render(true)).toMatch(/\sdisabled(=|\s|>)/);
  });
});
