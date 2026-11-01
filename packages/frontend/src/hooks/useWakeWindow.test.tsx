import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { HotkeyProvider } from './useHotkeys';
import { useWakeWindow } from './useWakeWindow';
import { apiWithStatus } from '../api/client';

vi.mock('../api/client', () => ({ apiWithStatus: vi.fn() }));
const mobile = vi.hoisted(() => ({ value: false }));
vi.mock('./useIsMobile', () => ({ useIsMobile: () => mobile.value }));

function Example({ onChoice }: { onChoice: (value: string | null) => void }) {
  const wake = useWakeWindow();
  return <><button onClick={() => void wake.choose(12, 'Example').then(onChoice)}>Wake</button>{wake.dialog}</>;
}

beforeEach(() => {
  mobile.value = false;
  vi.mocked(apiWithStatus).mockReset();
  vi.mocked(apiWithStatus).mockResolvedValue({ status: 200, body: { currentMux: 'tmux', mode: 'ask', misao: { hosted: true, available: true }, shouldAsk: true } });
});

describe('wake selection', () => {
  it('confirms misao and persists a remembered choice', async () => {
    const chosen = vi.fn();
    render(<HotkeyProvider><Example onChoice={chosen} /></HotkeyProvider>);
    fireEvent.click(screen.getByText('Wake'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(dialog.querySelector('input')!);
    fireEvent.submit(dialog.querySelector('form')!);
    await waitFor(() => expect(chosen).toHaveBeenCalledWith('misao'));
    expect(apiWithStatus).toHaveBeenCalledWith('/settings/mux-switch', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ mode: 'misao' }) }));
  });
  it('shows the server and version from the plan without a status request', async () => {
    vi.mocked(apiWithStatus).mockResolvedValueOnce({ status: 200, body: { serverName: 'local', currentMux: 'tmux', mode: 'ask', misao: { hosted: true, available: true, version: '0.3.0' }, shouldAsk: true } });
    render(<HotkeyProvider><Example onChoice={vi.fn()} /></HotkeyProvider>);
    fireEvent.click(screen.getByText('Wake'));
    expect(await screen.findByText('local · misao 0.3.0')).toBeInTheDocument();
    expect(apiWithStatus).toHaveBeenCalledTimes(1);
  });
  it('uses tmux without asking when misao is not installed even in misao mode', async () => {
    vi.mocked(apiWithStatus).mockResolvedValueOnce({ status: 200, body: { currentMux: 'tmux', mode: 'misao', misao: { hosted: false, available: false, reason: 'not_installed' }, shouldAsk: false } });
    const chosen = vi.fn();
    render(<HotkeyProvider><Example onChoice={chosen} /></HotkeyProvider>);
    fireEvent.click(screen.getByText('Wake'));
    await waitFor(() => expect(chosen).toHaveBeenCalledWith('tmux'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('chooses misao when installed but stopped, leaving failure to the respawn request', async () => {
    vi.mocked(apiWithStatus).mockResolvedValueOnce({ status: 200, body: { currentMux: 'tmux', mode: 'misao', misao: { hosted: true, available: false, reason: 'daemon_unreachable' }, shouldAsk: false } });
    const chosen = vi.fn();
    render(<HotkeyProvider><Example onChoice={chosen} /></HotkeyProvider>);
    fireEvent.click(screen.getByText('Wake'));
    await waitFor(() => expect(chosen).toHaveBeenCalledWith('misao'));
  });
  it('shows a failed preference save and leaves the choice pending', async () => {
    vi.mocked(apiWithStatus).mockResolvedValueOnce({ status: 200, body: { currentMux: 'tmux', mode: 'ask', misao: { hosted: true, available: true }, shouldAsk: true } }).mockResolvedValueOnce({ status: 500, body: {} });
    const chosen = vi.fn();
    render(<HotkeyProvider><Example onChoice={chosen} /></HotkeyProvider>);
    fireEvent.click(screen.getByText('Wake'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(dialog.querySelector('input')!);
    fireEvent.submit(dialog.querySelector('form')!);
    await screen.findByText('Could not save the preference');
    expect(chosen).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(chosen).toHaveBeenCalledWith(null));
  });
  it('opens an accessible mobile sheet and cancels with Escape', async () => {
    mobile.value = true;
    const chosen = vi.fn();
    render(<HotkeyProvider><Example onChoice={chosen} /></HotkeyProvider>);
    fireEvent.click(screen.getByText('Wake'));
    const sheet = await screen.findByRole('dialog', { name: 'Reopen with misao?' });
    await waitFor(() => expect(screen.getByText('Open with misao')).toHaveFocus());
    expect(Array.from(sheet.querySelectorAll('button')).map((button) => button.textContent)).toEqual(['Open with misao', 'Open with tmux']);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(chosen).toHaveBeenCalledWith(null));
  });
  it('cancels without choosing a mux', async () => {
    const chosen = vi.fn();
    render(<HotkeyProvider><Example onChoice={chosen} /></HotkeyProvider>);
    fireEvent.click(screen.getByText('Wake'));
    await screen.findByRole('dialog');
    await waitFor(() => expect(screen.getByText('Open with misao')).toHaveFocus());
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(chosen).toHaveBeenCalledWith(null));
  });
});
