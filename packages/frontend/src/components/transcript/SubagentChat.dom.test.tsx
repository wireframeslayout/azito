import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SubagentChat from './SubagentChat';
import { HotkeyProvider } from '../../hooks/useHotkeys';

const api = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', () => ({ apiWithStatus: api }));
vi.mock('../../hooks/useNotificationChannel', () => ({ useNotificationChannel: () => {} }));
vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('./ConversationView', () => ({ default: ({ subagentId, subagentRelay }: { subagentId?: string; subagentRelay?: { kind: string } }) => <div>view:{subagentId ?? 'parent'}{subagentId && `:${subagentRelay?.kind === 'available' ? 'relay' : 'disabled'}`}</div> }));

const agent = { id: 'child', name: 'worker', description: 'work', agentType: 'Explore', model: null, status: 'unknown', routingName: 'worker' };
const props = { windowId: 1, sessionId: 'first', agentType: 'claude', paneId: '%1', agentDetected: true, onParentChanged: vi.fn() };

describe('subagent selection', () => {
  const scrollIntoView = vi.fn();
  beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} }); localStorage.clear(); api.mockReset(); scrollIntoView.mockClear(); Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView }); });
  afterEach(() => { delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView; });
  it('shows the continuation indicator only while content remains to the right', async () => {
    api.mockResolvedValue({ status: 200, body: { sessionId: 'first', subagents: [agent] } });
    const view = render(<SubagentChat {...props} />);
    await screen.findByText('view:parent');
    const strip = screen.getByRole('button', { name: 'subagents.parent' }).parentElement!;
    Object.defineProperties(strip, { clientWidth: { configurable: true, value: 100 }, scrollWidth: { configurable: true, value: 200 }, scrollLeft: { configurable: true, writable: true, value: 0 } });
    fireEvent.scroll(strip);
    expect(view.container.querySelector('.lucide-chevron-right')).toBeInTheDocument();
    strip.scrollLeft = 100;
    fireEvent.scroll(strip);
    expect(view.container.querySelector('.lucide-chevron-right')).not.toBeInTheDocument();
  });
  it('brings a restored child into view', async () => {
    localStorage.setItem('azito.subagent.1.first', 'third');
    api.mockResolvedValue({ status: 200, body: { sessionId: 'first', subagents: [agent, { ...agent, id: 'second' }, { ...agent, id: 'third' }] } });
    render(<SubagentChat {...props} />);
    await screen.findByText('view:third:disabled');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
    const selectedButton = screen.getAllByRole('button', { name: /worker/ }).find(button => button.getAttribute('aria-pressed') === 'true');
    expect(scrollIntoView.mock.instances).toContain(selectedButton?.parentElement?.parentElement);
  });
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
  it('keeps long descriptions available and selects among multiple agents', async () => {
    const longName = 'A very long agent name '.repeat(20);
    const description = 'A detailed description '.repeat(20);
    api.mockResolvedValue({ status: 200, body: { sessionId: 'first', subagents: [agent, { ...agent, id: 'long', name: longName, description, model: 'test-model', routingName: 'long' }] } });
    render(<HotkeyProvider><SubagentChat {...props} /></HotkeyProvider>);
    const button = await screen.findByRole('button', { name: new RegExp('A very long agent name') });
    expect(button).toHaveAccessibleDescription(description.trim());
    expect(button).toHaveAttribute('title', expect.stringContaining(description));
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('view:long:relay')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'subagents.details' })[1]);
    expect(screen.getByRole('dialog')).toHaveTextContent(longName.trim());
    expect(screen.getByRole('dialog')).toHaveTextContent(description.trim());
    expect(screen.getByRole('dialog')).toHaveTextContent('Explore · test-model · subagents.status.unknown');
    fireEvent.click(screen.getByRole('button', { name: 'actions.close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('updates open details and closes them when the agent disappears', async () => {
    api.mockResolvedValue({ status: 200, body: { sessionId: 'first', subagents: [agent] } });
    render(<HotkeyProvider><SubagentChat {...props} /></HotkeyProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'subagents.details' }));
    api.mockResolvedValue({ status: 200, body: { sessionId: 'first', subagents: [{ ...agent, description: 'updated' }] } });
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(screen.getByRole('dialog')).toHaveTextContent('updated'));
    api.mockResolvedValue({ status: 200, body: { sessionId: 'first', subagents: [] } });
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
  it('shows the empty state and allows retry after an error', async () => {
    api.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ status: 200, body: { sessionId: 'first', subagents: [] } });
    render(<SubagentChat {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'windowChat.retry' }));
    expect(await screen.findByText('subagents.empty')).toBeInTheDocument();
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
