import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ActiveWindowRow } from './useActiveWindowRows';
import type { NotificationHandlers } from './useNotificationChannel';
import { LookoutNotifier } from './useLookoutNotifier';
import { writeLookoutNotifyInterval } from '../lib/lookoutNotifyInterval';

const state = vi.hoisted(() => ({ handlers: {} as NotificationHandlers, rows: [] as ActiveWindowRow[], watched: false, open: false, navigate: vi.fn(), terminal: vi.fn(), drawer: vi.fn() }));
vi.mock('./useNotificationChannel', () => ({ useNotificationChannel: (handlers: NotificationHandlers) => { state.handlers = handlers; } }));
vi.mock('./useWorkspaceCatalog', () => ({ useWorkspaceCatalog: () => ({ allProjects: [], allTasks: [] }) }));
vi.mock('./useLookout', () => ({ useLookout: () => ({ rows: state.rows, open: state.open, openDrawer: state.drawer }) }));
vi.mock('./useAgentActivity', () => ({ useAgentActivity: () => ({ isWatched: () => state.watched }) }));
vi.mock('./useCrossProjectNavigation', () => ({ useCrossProjectNavigation: () => ({ openTerminal: state.terminal }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => state.navigate }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, opts?: { name?: string; count?: number }) => opts?.name ? `${key}: ${opts.name}` : opts?.count ? `${key}: ${opts.count}` : key }) }));
beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); state.rows = []; state.open = false; state.watched = false; vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); });
it('removes old history at mount without reading it', () => {
  localStorage.setItem('azito-notifications', 'old');
  const read = vi.spyOn(Storage.prototype, 'getItem');
  render(<LookoutNotifier>content</LookoutNotifier>);
  expect(localStorage.getItem('azito-notifications')).toBeNull();
  expect(read.mock.calls.filter(([key]) => key === 'azito-notifications')).toHaveLength(1);
  read.mockRestore();
});

it('delivers mux and firewall actions with their destinations', () => {
  writeLookoutNotifyInterval('immediate');
  render(<LookoutNotifier>content</LookoutNotifier>);
  act(() => { state.handlers.onMuxWake?.({ serverName: 's', windowId: 3, title: 'Window', reason: 'ask' }); state.handlers.onServerFirewall?.({ serverName: 's', diagnosis: { state: 'blocked', blockedBy: [], commands: [], checkedAt: 0, networkCategory: null } }); });
  fireEvent.click(screen.getByRole('button', { name: 'toast.mux: Window →' }));
  expect(state.terminal).toHaveBeenCalledWith({ serverName: 's', windowId: 3, target: '' }, undefined);
  fireEvent.click(screen.getByRole('button', { name: 'toast.firewall: s →' }));
  expect(state.navigate).toHaveBeenCalledWith('/servers/s');
});
it('filters watched windows again when the batch flushes', () => {
  state.rows = [{ key: 'x', title: 'x', status: 'running', taskId: 1, serverName: 's', target: 'x', windowId: 2 }];
  render(<LookoutNotifier>content</LookoutNotifier>);
  act(() => state.handlers.onTaskStatus?.({ taskId: 1, status: 'done', title: 'Task' }));
  state.watched = true;
  act(() => vi.advanceTimersByTime(300000));
  expect(screen.queryByRole('status')).toBeNull();
});
it('deduplicates immediate events, shows one toast, and dismisses with Escape', () => {
  writeLookoutNotifyInterval('immediate');
  render(<LookoutNotifier>content</LookoutNotifier>);
  act(() => { state.handlers.onTaskStatus?.({ taskId: 1, status: 'done', title: 'One' }); state.handlers.onTaskStatus?.({ taskId: 1, status: 'done', title: 'One' }); state.handlers.onTaskStatus?.({ taskId: 2, status: 'waiting_for_human', title: 'Two' }); });
  expect(screen.getAllByRole('status')).toHaveLength(1);
  expect(screen.getByRole('status')).toHaveTextContent('One · Two');
  act(() => vi.advanceTimersByTime(9000));
  expect(screen.getByRole('status')).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole('button', { name: 'toast.close' }), { key: 'Escape' });
  expect(screen.queryByRole('status')).toBeNull();
});
it('clears pending events when notifications are disabled', () => {
  render(<LookoutNotifier>content</LookoutNotifier>);
  act(() => state.handlers.onTaskStatus?.({ taskId: 1, status: 'done', title: 'One' }));
  act(() => writeLookoutNotifyInterval('off'));
  act(() => vi.advanceTimersByTime(300000));
  expect(screen.queryByRole('status')).toBeNull();
});
it('discards pending events when Lookout opens', () => {
  const view = render(<LookoutNotifier>content</LookoutNotifier>);
  act(() => state.handlers.onTaskStatus?.({ taskId: 1, status: 'done', title: 'One' }));
  state.open = true;
  view.rerender(<LookoutNotifier>content</LookoutNotifier>);
  state.open = false;
  view.rerender(<LookoutNotifier>content</LookoutNotifier>);
  act(() => vi.advanceTimersByTime(300000));
  expect(screen.queryByRole('status')).toBeNull();
});
it('keeps a task notification when no matching window is known', () => {
  state.watched = true;
  render(<LookoutNotifier>content</LookoutNotifier>);
  act(() => state.handlers.onTaskStatus?.({ taskId: 1, status: 'done', title: 'One' }));
  act(() => vi.advanceTimersByTime(300000));
  expect(screen.getByRole('status')).toHaveTextContent('One');
});
it('only reports manual completion and reports API errors', () => {
  writeLookoutNotifyInterval('immediate');
  render(<LookoutNotifier>content</LookoutNotifier>);
  const base = { serverName: 's', target: 'pane', running: false, source: 'operation' as const, operation: true };
  act(() => state.handlers.onAgentActivity?.({ ...base, reason: 'completed' }));
  expect(screen.queryByRole('status')).toBeNull();
  act(() => state.handlers.onAgentActivity?.({ ...base, reason: 'api_error' }));
  expect(screen.getByRole('status')).toHaveTextContent('toast.failed: 1');
});
it('bundles events until five minutes and opens Lookout from the toast', () => {
  render(<LookoutNotifier>content</LookoutNotifier>);
  act(() => { state.handlers.onTaskStatus?.({ taskId: 1, status: 'done', title: 'One' }); state.handlers.onTaskStatus?.({ taskId: 2, status: 'phase_review', title: 'Two' }); });
  act(() => vi.advanceTimersByTime(299999));
  expect(screen.queryByRole('status')).toBeNull();
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole('status')).toHaveTextContent('One · Two');
  fireEvent.click(screen.getByRole('button', { name: /Lookout/ }));
  expect(state.drawer).toHaveBeenCalledOnce();
  expect(screen.queryByRole('status')).toBeNull();
});
it('suppresses an event already being watched', () => {
  state.watched = true;
  state.rows = [{ key: 'x', title: 'x', status: 'running', taskId: 1, serverName: 's', target: 'x', windowId: 2 }];
  render(<LookoutNotifier>content</LookoutNotifier>);
  act(() => state.handlers.onTaskStatus?.({ taskId: 1, status: 'done', title: 'One' }));
  state.watched = false;
  act(() => vi.advanceTimersByTime(300000));
  expect(screen.queryByRole('status')).toBeNull();
});
it('retains actionable alerts when Lookout opens or is already open', () => {
  const view = render(<LookoutNotifier>content</LookoutNotifier>);
  act(() => state.handlers.onMuxWake?.({ serverName: 's', windowId: 3, reason: 'misao_unavailable' }));
  state.open = true;
  view.rerender(<LookoutNotifier>content</LookoutNotifier>);
  act(() => state.handlers.onServerFirewall?.({ serverName: 's', diagnosis: { state: 'blocked', blockedBy: [], commands: [], checkedAt: 0, networkCategory: null } }));
  act(() => vi.advanceTimersByTime(300000));
  expect(screen.getByRole('status')).toHaveTextContent('toast.muxUnavailable');
  expect(screen.getByRole('status')).toHaveTextContent('toast.firewall');
});
