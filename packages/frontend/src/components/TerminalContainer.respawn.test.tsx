import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TerminalContainer } from './TerminalContainer';
import { api } from '../api/client';

vi.mock('../api/client', () => ({ api: vi.fn(async () => ({ tmuxTarget: 's:new' })) }));
vi.mock('react-i18next', async (original) => ({ ...(await original<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../hooks/useWakeWindow', () => ({ useWakeWindow: () => ({ choose: async () => 'tmux', dialog: null }) }));
vi.mock('../hooks/useServerStatuses', () => ({ useServerStatuses: () => ({ servers: [{ name: 'local', defaultMux: 'tmux' }] }) }));
vi.mock('../hooks/useWorkspaceTargets', () => ({ useWorkspaceTargets: () => ({}) }));
vi.mock('../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../hooks/useWindowViewMode', () => ({ useWindowViewMode: () => ['terminal', vi.fn()] }));
vi.mock('./transcript/transcriptStyle', () => ({ useTranscriptStyle: () => ['default', vi.fn()] }));
vi.mock('./WindowStatusDropdown', () => ({ WindowStatusDropdown: () => null, findWindow: () => ({ id: 7, sleeping: false, windowType: 'terminal', tmuxTarget: 's:old' }), isTaskOwnedWindow: () => false }));
vi.mock('./XTermView', () => ({ default: ({ onWindowNotFound }: { onWindowNotFound: () => void }) => <button onClick={onWindowNotFound}>missing</button> }));
vi.mock('../lib/fetchServerSessions', () => ({ fetchSessionsOrUndefined: async () => undefined }));

describe('terminal window recreation', () => {
  it('sends missing-window confirmation from the recreation button', async () => {
    render(<TerminalContainer serverName="local" target="s:old.0" resolveOnServer />);
    fireEvent.click(screen.getByText('missing'));
    fireEvent.click(screen.getByText('terminal.respawn'));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/windows/7/respawn', expect.objectContaining({ body: JSON.stringify({ force: false, mux: 'tmux', allowMissing: true }) })));
  });
});
