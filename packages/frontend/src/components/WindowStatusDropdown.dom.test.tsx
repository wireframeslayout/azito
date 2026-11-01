import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WindowStatusDropdown } from './WindowStatusDropdown';
import type { Session } from '../pages/workspace/types';

vi.mock('../hooks/useToast', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../hooks/useAgentDefinitions', () => ({ useAgentDefinitions: () => ({ agents: [] }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: () => 'Window' }) }));

const ref = JSON.stringify({ kind: 'misao', workspace: 'dev', window: 'w_01234567890123456789012345' });
const sessions: Session[] = [{ name: 'dev', kind: 'misao', windows: [{ index: 1, name: 'Editor', ref, windowId: null, panes: [] }] }];

describe('WindowStatusDropdown', () => {
  it('updates an unregistered misao window name when sessions arrive', () => {
    const props = { serverName: 'local', target: 'dev:w_01234567890123456789012345', muxKind: 'misao' as const, terminalRef: { kind: 'ref' as const, serverName: 'local', ref, pane: 1 }, project: null, allTasks: [] };
    const view = render(<WindowStatusDropdown {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Window status' }));
    expect(screen.getByText('Window')).toBeTruthy();
    expect(screen.queryByText(props.target)).toBeNull();
    view.rerender(<WindowStatusDropdown {...props} sessions={sessions} />);
    expect(screen.getByText('Editor')).toBeTruthy();
    expect(screen.getByText('misao')).toBeTruthy();
  });

  it('keeps the tmux target visible', () => {
    render(<WindowStatusDropdown serverName="local" target="dev:editor" muxKind="tmux" project={null} allTasks={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Window status' }));
    expect(screen.getByText('dev:editor')).toBeTruthy();
    expect(screen.getByText('tmux')).toBeTruthy();
  });
});
