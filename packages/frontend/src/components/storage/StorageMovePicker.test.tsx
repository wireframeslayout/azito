import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HotkeyProvider } from '../../hooks/useHotkeys';
import type { StorageFilesBackend } from '../files/backend/StorageFilesBackend';
import { StorageMovePicker } from './StorageMovePicker';

vi.mock('react-i18next', async (original) => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t: (key: string) => key }) }));
const backend = { source: 'storage:1', listPage: vi.fn(async () => ({ entries: [], nextCursor: null })) } as unknown as StorageFilesBackend;
function Harness() {
  const [open, setOpen] = useState(false);
  return <HotkeyProvider><button onClick={() => setOpen(true)}>open</button>{open && <StorageMovePicker backend={backend} initialPath="" disabled={false} mobile={false} onMove={vi.fn()} onCancel={() => setOpen(false)} />}</HotkeyProvider>;
}
describe('StorageMovePicker', () => {
  it('focuses the dialog, prevents a no-op move, closes on Escape and restores focus', async () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'open' });
    trigger.focus(); fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'list.cancel' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'list.moveHere' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
