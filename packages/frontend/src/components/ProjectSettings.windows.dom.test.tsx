import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { WindowsSection } from './ProjectSettings';

vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../hooks/useIsMobile', () => ({ useIsMobile: () => false }));

describe('project windows display', () => {
  it.each(['misao', 'tmux'] as const)('renders the %s window', (kind) => {
    const target = kind === 'misao' ? 'ses:w_01234567890123456789012345' : 'ses:win';
    const window = { id: 12, serverName: 'local', tmuxTarget: target, label: 'Editor', muxRef: { kind, workspace: 'ses', window: 'win' } };
    const props = { settings: { project: { windows: [window] }, handleRemoveWindow: vi.fn() }, addWindowModal: { openAddWindow: vi.fn() } } as unknown as ComponentProps<typeof WindowsSection>;
    render(<WindowsSection {...props} />);
    expect(screen.getByText(kind === 'misao' ? 'local · misao' : 'local · tmux ses:win')).toBeTruthy();
    expect(document.body.textContent).not.toContain('w_01234567890123456789012345');
    expect(screen.getByRole('button', { name: 'common:actions.remove' })).toBeTruthy();
  });
});
