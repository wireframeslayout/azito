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
  vi.mocked(apiWithStatus).mockResolvedValue({ status: 200, body: { mux: 'tmux', policy: 'ask', shouldAsk: true } });
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
    expect(apiWithStatus).toHaveBeenCalledWith('/settings/mux-switch', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ policy: 'misao' }) }));
  });
  it('shows a failed preference save and leaves the choice pending', async () => {
    vi.mocked(apiWithStatus).mockResolvedValueOnce({ status: 200, body: { mux: 'tmux', policy: 'ask', shouldAsk: true } }).mockResolvedValueOnce({ status: 500, body: {} });
    const chosen = vi.fn();
    render(<HotkeyProvider><Example onChoice={chosen} /></HotkeyProvider>);
    fireEvent.click(screen.getByText('Wake'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(dialog.querySelector('input')!);
    fireEvent.submit(dialog.querySelector('form')!);
    await screen.findByText('Could not save the preference');
    expect(chosen).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(chosen).toHaveBeenCalledWith(null));
  });
  it('opens an accessible mobile sheet and cancels with Escape', async () => {
    mobile.value = true;
    const chosen = vi.fn();
    render(<HotkeyProvider><Example onChoice={chosen} /></HotkeyProvider>);
    fireEvent.click(screen.getByText('Wake'));
    await screen.findByRole('dialog', { name: 'Reopen with misao?' });
    await waitFor(() => expect(screen.getByText('Use misao')).toHaveFocus());
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(chosen).toHaveBeenCalledWith(null));
  });
  it('cancels without choosing a mux', async () => {
    const chosen = vi.fn();
    render(<HotkeyProvider><Example onChoice={chosen} /></HotkeyProvider>);
    fireEvent.click(screen.getByText('Wake'));
    await screen.findByRole('dialog');
    await waitFor(() => expect(screen.getByText('Use misao')).toHaveFocus());
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(chosen).toHaveBeenCalledWith(null));
  });
});
