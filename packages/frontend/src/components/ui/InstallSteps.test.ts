import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { InstallSteps } from './InstallSteps';

const steps = [{ step: 'preflight', status: 'error' as const, message: 'refused' }];

describe('InstallSteps', () => {
  it('shows the original message by default', () => {
    expect(renderToStaticMarkup(createElement(InstallSteps, { steps }))).toContain('refused');
  });
  it('uses the supplied renderer', () => {
    const html = renderToStaticMarkup(createElement(InstallSteps, { steps, renderMessage: (step) => `Details: ${step.message}` }));
    expect(html).toContain('Details: refused');
  });
});
