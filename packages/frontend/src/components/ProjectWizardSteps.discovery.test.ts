import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// The step pulls in modules that start i18n against `document`; the test passes its own `t`.
vi.mock('../i18n', () => ({ default: {} }));

import { DiscoveryResult, type TFunc } from './ProjectWizardSteps';

const t = ((key: string) => key) as unknown as TFunc;
const REASON = 'Git for Windows (git.exe) was not found on this host. Install it with "winget install --id Git.Git -e".';

function render(failureReason: string | null): string {
  return renderToStaticMarkup(createElement(DiscoveryResult, {
    t, discovery: 'error', failureReason, selectedRemoteUrls: new Set<string>(), toggleRemoteSelected: () => {},
  }));
}

describe('DiscoveryResult when the scan could not run', () => {
  it('shows the hub reason (Git for Windows missing) under the failure line', () => {
    const html = render(REASON);
    expect(html).toContain('wizard.code.pathCheckFailed');
    expect(html).toContain('winget install --id Git.Git -e');
  });

  it('shows only the failure line when the hub gave no reason', () => {
    const html = render(null);
    expect(html).toContain('wizard.code.pathCheckFailed');
    expect(html).not.toContain('winget');
  });
});
