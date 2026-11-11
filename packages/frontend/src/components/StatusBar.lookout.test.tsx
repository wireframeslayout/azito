import { StatusBarItem } from './statusbar/StatusBarItem';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { StatusBar } from './StatusBar';
import { HotkeyProvider } from '../hooks/useHotkeys';
const mocks = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn(), openTask: vi.fn(), attention: 2, serverLoaded: true, focused: null as null | { serverName: string; label: string } }));
vi.mock('../hooks/useServerStatuses', () => ({ useServerStatuses: () => ({ servers: [{ name: 'local', defaultMux: 'misao' }], serversLoaded: mocks.serverLoaded }) }));
vi.mock('../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../hooks/useAgentActivity', () => ({ useAgentActivity: () => ({ snapshotStatus: 'ready', retrySnapshot: vi.fn() }) }));
vi.mock('../hooks/useCrossProjectNavigation', () => ({ useCrossProjectNavigation: () => ({ openTask: mocks.openTask, openTerminal: vi.fn() }) }));
vi.mock('../hooks/useLookout', () => ({ useLookout: () => ({ open: false, openDrawer: mocks.open, closeDrawer: mocks.close, sections: { counts: { attention: mocks.attention } } }) }));
vi.mock('./lookout/LookoutDrawer', () => ({ LookoutDrawer: ({ onOpenItem }: { onOpenItem: (item: unknown) => void }) => <button onClick={() => onOpenItem({ primaryRow: { taskId: 42, serverName: "local", target: "s:1" } })}>open row</button> }));
vi.mock('./search/GlobalSearch', () => ({ useOpenGlobalSearch: () => vi.fn() }));
vi.mock('../hooks/useWorkspaceTargets', () => ({ useWorkspaceTargets: () => ({ focusedTargetDisplay: mocks.focused }) }));
vi.mock('../hooks/useSystemUpdate', () => ({ useSystemUpdate: () => ({ status: null, startUpdate: vi.fn(), checkNow: vi.fn() }) }));
vi.mock('../hooks/useToast', () => ({ useToast: () => ({ showToast: vi.fn() }) }));
vi.mock('../hooks/useActivityDiagnostics', () => ({ useActivityDiagnostics: () => ({ rows: [], error: null }), DIAGNOSTICS_POLL_INTERVAL_MS: 1000 }));
it('shows the Lookout button and attention badge and opens it', () => {
  render(<HotkeyProvider><StatusBar servers={[]} /></HotkeyProvider>);
  const button = screen.getByRole('button', { name: /Lookout/ });
  expect(button).toHaveTextContent('2');
  fireEvent.click(button);
  expect(mocks.open).toHaveBeenCalledOnce();
});
it('keeps the Lookout button without a zero badge', () => {
  mocks.attention = 0;
  render(<HotkeyProvider><StatusBar servers={[]} /></HotkeyProvider>);
  expect(screen.getByRole('button', { name: /Lookout/ })).not.toHaveTextContent('0');
});

it('opens a referenced task when its catalog entry is unavailable', () => {
  render(<HotkeyProvider><StatusBar servers={[]} /></HotkeyProvider>);
  fireEvent.click(screen.getByText('open row'));
  expect(mocks.openTask).toHaveBeenCalledWith(42);
});

it('uses monospace only for the requested status labels', () => {
  const { rerender } = render(<StatusBarItem label="稼働検知" active={false} onClick={() => {}} />);
  expect(screen.getByRole('button', { name: '稼働検知' }).style.fontFamily).toBe('');
  rerender(<StatusBarItem label="Hub" mono active={false} onClick={() => {}} />);
  expect(screen.getByRole('button', { name: 'Hub' }).style.fontFamily).toBe('var(--font-mono)');
});

it('shows a known default mux for the displayed server', () => {
  mocks.focused = { serverName: 'local', label: 'window' };
  render(<HotkeyProvider><StatusBar servers={[{ serverName: 'local', type: 'local', measurement: null, unavailable: false } as never]} /></HotkeyProvider>);
  expect(screen.getByText(/misao/)).toBeInTheDocument();
  mocks.focused = null;
});
