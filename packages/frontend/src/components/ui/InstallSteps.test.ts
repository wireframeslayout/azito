import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { InstallSteps } from './InstallSteps';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => ({ 'localNetwork.guidance': 'Check local network permission or use Tailscale', 'localNetwork.detail': 'Original error' } as Record<string, string>)[key] }) }));

describe('InstallSteps', () => {
  it('shows guidance and the original error for a diagnosed failure', () => {
    const html = renderToStaticMarkup(createElement(InstallSteps, { steps: [{ step: 'preflight', status: 'error', message: 'raw', code: 'macos_local_network_permission', detail: 'EHOSTUNREACH' }] }));
    expect(html).toContain('Check local network permission or use Tailscale');
    expect(html).toContain('Original error: EHOSTUNREACH');
  });
  it('leaves other errors unchanged', () => {
    expect(renderToStaticMarkup(createElement(InstallSteps, { steps: [{ step: 'preflight', status: 'error', message: 'refused' }] }))).toContain('refused');
  });
});
