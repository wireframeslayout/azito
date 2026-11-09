import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { HotkeyProvider } from '../../hooks/useHotkeys';
import { BottomSheet } from './BottomSheet';
it('keeps the default sheet behaviour and supports optional keyboard detents', () => {
  const close = vi.fn();
  const { rerender } = render(<HotkeyProvider><BottomSheet open title="Sheet" onClose={close}><button>Content</button></BottomSheet></HotkeyProvider>);
  expect(screen.getByRole('dialog')).toHaveStyle({ maxHeight: '70vh' });
  rerender(<HotkeyProvider><BottomSheet open title="Sheet" onClose={close} detents={[{ label: 'Expand', height: '50vh' }, { label: 'Collapse', height: '90vh' }]}><button>Content</button></BottomSheet></HotkeyProvider>);
  expect(screen.getByRole('dialog')).toHaveStyle({ height: '50vh' });
  fireEvent.keyDown(screen.getByRole('button', { name: 'Expand' }), { key: 'ArrowUp' });
  expect(screen.getByRole('dialog')).toHaveStyle({ height: '90vh' });
  fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
  expect(screen.getByRole('dialog')).toHaveStyle({ height: '50vh' });
});
