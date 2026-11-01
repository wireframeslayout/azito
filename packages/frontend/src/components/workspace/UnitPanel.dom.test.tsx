import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { NowRunningSection } from './UnitPanel';

vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key === 'common:labels.window' ? 'Window' : key }) }));

vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../../hooks/useTerminalTargetOpener', () => ({ useOpenTerminalTarget: () => vi.fn() }));

describe('NowRunningSection window display', () => {
  it.each(['misao', 'tmux'] as const)('renders %s without changing tmux targets', (kind) => {
    const target = kind === 'misao' ? 'ses:w_01234567890123456789012345' : 'ses:win';
    const window = { id: 12, serverName: 'local', tmuxTarget: target, label: 'Editor', muxRef: { kind, workspace: 'ses', window: 'win' } };
    const props = { running: [{ unitId: 1, taskId: 1, windowId: 12, serverName: 'local', target }], unitTasks: [{ id: 1, title: 'Task', status: 'running', windows: [window] }], connectPane: vi.fn() } as unknown as ComponentProps<typeof NowRunningSection>;
    render(<NowRunningSection {...props} />);
    expect(screen.getByText(kind === 'misao' ? /Editor/ : /ses:win/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('w_01234567890123456789012345');
    expect(screen.getByRole('button')).toBeTruthy();
  });
});
