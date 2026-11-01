import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { HotkeyProvider, useHotkey, useHotkeyBindings, useOverlayStack } from './useHotkeys';
import { parseKeySpec } from '../lib/hotkeys/keySpec';
afterEach(() => localStorage.clear());
function Global({ handler }: { handler: () => void }) {
  useHotkey({ action: 'search.open', scope: 'global', when: 'not-editable', handler });
  return <input aria-label="input" />;
}
function Layer({ handler }: { handler: () => void }) {
  const ref = useRef<HTMLDivElement>(null); const { id } = useOverlayStack(true, ref);
  useHotkey({ action: 'local:escape', spec: parseKeySpec('Escape'), scope: 'overlay', overlayId: id, handler });
  return <div ref={ref} />;
}
function Change() { const { setBinding } = useHotkeyBindings(); return <button onClick={() => setBinding('search.open', parseKeySpec('Ctrl+K'))}>Change</button>; }
it('suppresses global keys in editable targets and updates bindings', () => {
  const handler = vi.fn(); render(<HotkeyProvider><Global handler={handler} /><Change /></HotkeyProvider>);
  fireEvent.keyDown(screen.getByLabelText('input'), { key: ' ' }); fireEvent.keyDown(screen.getByLabelText('input'), { key: ' ' }); expect(handler).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Change')); fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true }); expect(handler).toHaveBeenCalledOnce();
});
it('only dispatches escape to the top layer and suppresses global keys', async () => {
  const global = vi.fn(); const first = vi.fn(); const second = vi.fn();
  render(<HotkeyProvider><Global handler={global} /><Layer handler={first} /><Layer handler={second} /></HotkeyProvider>);
  fireEvent.keyDown(document.body, { key: ' ' }); fireEvent.keyDown(document.body, { key: ' ' });
  fireEvent.keyDown(document.body, { key: 'Escape' }); await waitFor(() => expect(second).toHaveBeenCalledOnce());
  expect(first).not.toHaveBeenCalled(); expect(global).not.toHaveBeenCalled();
});
it('honors preventDefault during propagation for escape', async () => {
  const close = vi.fn(); render(<HotkeyProvider><Layer handler={close} /><input aria-label="escape" onKeyDown={e => e.preventDefault()} /></HotkeyProvider>);
  fireEvent.keyDown(screen.getByLabelText('escape'), { key: 'Escape' }); await Promise.resolve(); expect(close).not.toHaveBeenCalled();
});
