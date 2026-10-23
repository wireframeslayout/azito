import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BlockedActionButton } from './BlockedActionButton';

const REASON = 'Not available yet for Windows agents';

function render(props: Record<string, unknown>): string {
  return renderToStaticMarkup(createElement(BlockedActionButton, { variant: 'primary', children: 'Execute', ...props }));
}

describe('BlockedActionButton, inline reason', () => {
  const html = render({ blockedReason: REASON, reasonDisplay: 'inline' });

  it('stays focusable: aria-disabled, never the disabled attribute', () => {
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toMatch(/\sdisabled(=|\s|>)/);
  });

  it('shows the reason as text and ties the button to it with aria-describedby', () => {
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toMatch(new RegExp(`<span id="${describedBy}"[^>]*>${REASON}</span>`));
  });
});

describe('BlockedActionButton, a reason that is already on screen', () => {
  it('points at it and renders no second copy', () => {
    const html = render({ blockedReason: REASON, reasonId: 'form-notice' });
    expect(html).toContain('aria-describedby="form-notice"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain(REASON);
  });
});

describe('BlockedActionButton, nothing blocked (Linux / macOS)', () => {
  it('is an ordinary button: no aria-disabled, no description', () => {
    for (const blockedReason of [null, undefined]) {
      const html = render({ blockedReason, reasonDisplay: 'inline' });
      expect(html).not.toContain('aria-disabled');
      expect(html).not.toContain('aria-describedby');
      expect(html).toContain('Execute');
    }
  });

  it('keeps a disabled of its own (loading, invalid input) as a real disabled button', () => {
    expect(render({ blockedReason: null, disabled: true })).toMatch(/\sdisabled(=|\s|>)/);
  });
});
