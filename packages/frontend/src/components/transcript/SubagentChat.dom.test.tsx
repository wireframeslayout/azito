import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SubagentChat from './SubagentChat';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', () => ({ apiWithStatus: api }));
vi.mock('../../hooks/useNotificationChannel', () => ({ useNotificationChannel: () => {} }));
vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('./ConversationView', () => ({ default: ({ subagentId, subagentRelay }: { subagentId?: string; subagentRelay?: { kind: string } }) => <div>view:{subagentId ?? 'parent'}{subagentId && `:${subagentRelay?.kind === 'available' ? 'relay' : 'disabled'}`}</div> }));

const agent = { id: 'child', name: 'worker', description: 'work', agentType: 'Explore', model: null, status: 'unknown', routingName: 'worker' };
const props = { windowId: 1, sessionId: 'first', agentType: 'claude', paneId: '%1', agentDetected: true, onParentChanged: vi.fn() };

describe('subagent selection', () => {
  beforeEach(() => { localStorage.clear(); api.mockReset(); });
  it('restores only after a successful list and isolates parent sessions', async () => {
    localStorage.setItem('azito.subagent.1.first', 'child');
    api.mockResolvedValue({ status: 200, body: { sessionId: 'first', subagents: [agent] } });
    const view = render(<SubagentChat {...props} />);
    await screen.findByText('view:child:relay');
    fireEvent.click(screen.getByRole('button', { name: 'subagents.parent' }));
    expect(localStorage.getItem('azito.subagent.1.first')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /worker/ }));
    expect(localStorage.getItem('azito.subagent.1.first')).toBe('child');
    api.mockResolvedValue({ status: 200, body: { sessionId: 'second', subagents: [agent] } });
    view.rerender(<SubagentChat {...props} sessionId="second" />);
    await waitFor(() => expect(screen.getByText('view:parent')).toBeTruthy());
  });
  it('disables relay for duplicate or missing names', async () => {
    api.mockResolvedValue({ status: 200, body: { sessionId: 'first', subagents: [agent, { ...agent, id: 'other' }] } });
    render(<SubagentChat {...props} />);
    const buttons = await screen.findAllByRole('button', { name: /worker/ });
    fireEvent.click(buttons[0]);
    expect(screen.getByText('view:child:disabled')).toBeTruthy();
  });
  it('retains a saved selection on a temporary failure', async () => {
    localStorage.setItem('azito.subagent.1.first', 'child');
    api.mockRejectedValue(new Error('offline'));
    render(<SubagentChat {...props} />);
    await screen.findByText('subagents.error');
    expect(localStorage.getItem('azito.subagent.1.first')).toBe('child');
  });
});
