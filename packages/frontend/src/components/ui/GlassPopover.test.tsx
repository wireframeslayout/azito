import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { HotkeyProvider } from '../../hooks/useHotkeys';
import { GlassPopover } from './GlassPopover';

it('keeps menu selection and outside dismissal behavior', async () => {
  const close = vi.fn(); const select = vi.fn();
  render(<HotkeyProvider><button>Outside</button><GlassPopover open onClose={close} ariaLabel="Menu" items={[{ key: 'a', label: 'Choice', onSelect: select }]} /></HotkeyProvider>);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Choice' }));
  expect(select).toHaveBeenCalledOnce();
  fireEvent.pointerDown(screen.getByText('Outside'));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
});
