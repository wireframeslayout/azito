import { act, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { AgentActivityPayload } from '../types/notification';
import { AgentActivityProvider, useAgentActivity } from './useAgentActivity';
import { useActiveWindowRows } from './useActiveWindowRows';

vi.mock('../api/client', () => ({ api: vi.fn() }));
const events = vi.hoisted(() => ({ handlers: {} as { onAgentActivity: (payload: AgentActivityPayload) => void; onConnected: () => void; onWindowRenamed: (payload: { serverName: string; target: string; newName: string; windowId?: number }) => void } }));
vi.mock('./useNotificationChannel', () => ({ useNotificationChannel: (handlers: typeof events.handlers) => { events.handlers = handlers; } }));
const targets = vi.hoisted(() => ({ activeTabId: null as string | null, focusedTarget: null as string | null }));
vi.mock('./useWorkspaceTargets', () => ({ useWorkspaceTargets: () => targets }));

const running: AgentActivityPayload = { serverName: 'local', target: 's:1', running: true, source: 'manual', operation: false };
let pending: Array<{ resolve: (value: AgentActivityPayload[]) => void; reject: (reason: Error) => void }>;
function View() {
  const activity = useAgentActivity();
  return <><output>{JSON.stringify({ entries: [...activity.entries.values()], finished: activity.finishedEntries, indicator: activity.windowIndicator('local', 's:1') })}</output>
    <button onClick={() => activity.markFinishedSeen('local', 's:1')}>seen</button>
    <button onClick={() => activity.setRetention({ maxCount: 0, retentionMs: 3600000 })}>zero</button></>;
}
function state() { return JSON.parse(screen.getByRole('status').textContent!); }
function send(payload: AgentActivityPayload) { act(() => events.handlers.onAgentActivity(payload)); }
async function resolve(index: number, value: AgentActivityPayload[]) { await act(async () => pending[index].resolve(value)); }
function mount() { return render(<AgentActivityProvider><View /></AgentActivityProvider>); }

beforeEach(() => {
  localStorage.clear();
  targets.activeTabId = null;
  targets.focusedTarget = null;
  pending = [];
  vi.mocked(api).mockReset().mockImplementation(() => new Promise((resolve, reject) => pending.push({ resolve, reject })));
});

it('keeps a completion received before an old initial snapshot and does not replay its side effect', async () => {
  mount();
  send({ ...running, running: false, reason: 'completed' });
  const finishedAt = state().finished[0].finishedAt;
  await resolve(0, [running]);
  expect(state()).toMatchObject({ entries: [], finished: [{ target: 's:1', finishedAt }], indicator: 'finished' });
});

it('replays multiple events in order for different keys during reconnect', async () => {
  mount();
  await resolve(0, []);
  act(() => events.handlers.onConnected());
  send(running);
  send({ ...running, status: 'blocked' });
  send({ ...running, target: 's:2' });
  send({ ...running, target: 's:2', running: false, reason: 'deleted' });
  await resolve(1, [{ ...running, target: 's:2' }]);
  expect(state().entries).toMatchObject([{ target: 's:1', status: 'blocked' }]);
});

it('ignores older overlapping responses and preserves events after the latest request starts', async () => {
  mount();
  act(() => events.handlers.onConnected());
  send(running);
  await resolve(1, []);
  await resolve(0, [{ ...running, target: 'old:1' }]);
  expect(state().entries).toMatchObject([{ target: 's:1' }]);
});

it('retains live state on failure and processes later events', async () => {
  mount();
  send(running);
  await act(async () => pending[0].reject(new Error('offline')));
  send({ ...running, status: 'blocked' });
  expect(state().entries).toMatchObject([{ status: 'blocked' }]);
});

it('a remount shows only its own snapshot', async () => {
  const view = mount();
  view.unmount();
  mount();
  await resolve(0, [{ ...running, target: 'old:1' }]);
  await resolve(1, [{ ...running, target: 'new:1' }]);
  expect(state().entries).toMatchObject([{ target: 'new:1' }]);
});

it.each([undefined, 1])('removes a completed row on deletion with windowId %s and persists the rest', async (windowId) => {
  mount();
  await resolve(0, []);
  send({ ...running, windowId: 1, running: false, reason: 'completed' });
  send({ ...running, target: 's:2', windowId: 2, running: false, reason: 'completed' });
  send({ ...running, windowId, running: false, reason: 'deleted' });
  expect(state().finished).toMatchObject([{ target: 's:2', windowId: 2 }]);
  expect(JSON.parse(localStorage.getItem('active-windows-finished')!)).toMatchObject([{ target: 's:2', windowId: 2 }]);
});

it('keeps a confirmed completion until retention removes it, and a later completion is unread', async () => {
  mount();
  await resolve(0, []);
  send({ ...running, running: false, reason: 'completed' });
  act(() => screen.getByText('seen').click());
  expect(state().finished[0].seenAt).toEqual(expect.any(Number));
  expect(state().indicator).toBeNull();
  send({ ...running, running: false, reason: 'completed' });
  expect(state().finished[0].seenAt).toBeUndefined();
  expect(state().indicator).toBe('finished');
  act(() => screen.getByText('zero').click());
  expect(state().finished).toHaveLength(1);
  act(() => screen.getByText('seen').click());
  expect(state().finished).toHaveLength(0);
});

it('records a completion in the focused window as seen', async () => {
  targets.activeTabId = 'terminal:local::w42.1';
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  mount();
  await resolve(0, []);
  send({ ...running, windowId: 42, running: false, reason: 'completed' });
  expect(state().finished[0].seenAt).toEqual(expect.any(Number));
  vi.restoreAllMocks();
});

it('restores a confirmed row on remount', async () => {
  const view = mount();
  await resolve(0, []);
  send({ ...running, running: false, reason: 'completed' });
  act(() => screen.getByText('seen').click());
  expect(JSON.parse(localStorage.getItem('active-windows-finished')!)).toHaveLength(1);
  view.unmount();
  mount();
  await resolve(1, []);
  expect(state().finished).toHaveLength(1);
});

it('marks an unread completion when focus and the event change together', async () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const view = mount();
  await resolve(0, []);
  act(() => {
    targets.activeTabId = 'terminal:local::w42.1';
    events.handlers.onAgentActivity({ ...running, windowId: 42, running: false, reason: 'completed' });
    view.rerender(<AgentActivityProvider><View /></AgentActivityProvider>);
  });
  expect(state().finished[0].seenAt).toEqual(expect.any(Number));
  vi.restoreAllMocks();
});

it('shows rename in active rows without an activity transition, including during snapshot loading', async () => {
  function Rows() {
    const { rows } = useActiveWindowRows({ windowById: new Map(), taskById: new Map() });
    return <output>{rows.map((row) => row.title).join(',')}</output>;
  }
  render(<AgentActivityProvider><Rows /></AgentActivityProvider>);
  send(running);
  act(() => events.handlers.onWindowRenamed({ serverName: 'local', target: 's:1', newName: 'Renamed' }));
  expect(screen.getByRole('status')).toHaveTextContent('Renamed');
  await resolve(0, [running]);
  expect(screen.getByRole('status')).toHaveTextContent('Renamed');
});

it('retains an unregistered rename through status, reconnect and completion, then forgets it', async () => {
  mount();
  await resolve(0, [running]);
  act(() => events.handlers.onWindowRenamed({ serverName: 'local', target: 's:1', newName: 'Renamed' }));
  send({ ...running, status: 'blocked', label: 'Old' });
  expect(state().entries).toMatchObject([{ label: 'Renamed', status: 'blocked' }]);
  act(() => events.handlers.onConnected());
  await resolve(1, [{ ...running, label: 'Old' }]);
  expect(state().entries).toMatchObject([{ label: 'Renamed' }]);
  send({ ...running, running: false, reason: 'completed', label: 'Old' });
  expect(state().finished).toMatchObject([{ label: 'Renamed' }]);
  send({ ...running, label: 'Replacement' });
  expect(state().entries).toMatchObject([{ label: 'Replacement' }]);
});

it('updates a registered active row title when its window label changes', async () => {
  function Rows({ label }: { label: string }) {
    const { rows } = useActiveWindowRows({
      windowById: new Map([[42, { id: 42, serverName: 'local', tmuxTarget: 's:1', label, labelSource: 'user' }]]),
      taskById: new Map(),
    });
    return <output>{rows.map((row) => row.title).join(',')}</output>;
  }
  const view = render(<AgentActivityProvider><Rows label="Old" /></AgentActivityProvider>);
  await resolve(0, [{ ...running, windowId: 42 }]);
  expect(screen.getByRole('status')).toHaveTextContent('Old · W-42');
  act(() => events.handlers.onWindowRenamed({ serverName: 'local', target: 's:1', newName: 'New', windowId: 42 }));
  view.rerender(<AgentActivityProvider><Rows label="New" /></AgentActivityProvider>);
  expect(screen.getByRole('status')).toHaveTextContent('New · W-42');
});
