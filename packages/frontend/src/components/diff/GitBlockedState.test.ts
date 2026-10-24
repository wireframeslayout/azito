import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import GitBlockedState from './GitBlockedState';

describe('GitBlockedState', () => {
  it('shows the reason as a status message', () => {
    const html = renderToStaticMarkup(createElement(GitBlockedState, { reason: 'Not available yet for Windows agents' }));
    expect(html).toContain('role="status"');
    expect(html).toContain('Not available yet for Windows agents');
  });
});
