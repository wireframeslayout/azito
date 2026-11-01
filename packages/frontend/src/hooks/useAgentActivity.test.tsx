import { act, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { AgentActivityPayload } from '../types/notification';
import { AgentActivityProvider, useAgentActivity } from './useAgentActivity';

vi.mock('../api/client', () => ({ api: vi.fn() }));
const events = vi.hoisted(() => ({ handlers: {} as { onAgentActivity: (payload: AgentActivityPayload) => void; onConnected: () => void } }));
vi.mock('./useNotificationChannel', () => ({ useNotificationChannel: (handlers: typeof events.handlers) => { events.handlers = handlers; } }));
vi.mock('./useWorkspaceTargets', () => ({ useWorkspaceTargets: () => ({ activeTabId: null, focusedTarget: null }) }));

const running: AgentActivityPayload = { serverName: 'local', target: 's:1', running: true, source: 'manual', operation: false };
let pending: Array<{ resolve: (value: AgentActivityPayload[]) => void; reject: (reason: Error) => void }>;
function View() {
  const activity = useAgentActivity();
  return <output>{JSON.stringify({ entries: [...activity.entries.values()], finished: activity.finishedEntries, indicator: activity.windowIndicator('local', 's:1') })}</output>;
}
function state() { return JSON.parse(screen.getByRole('status').textContent!); }
function send(payload: AgentActivityPayload) { act(() => events.handlers.onAgentActivity(payload)); }
async function resolve(index: number, value: AgentActivityPayload[]) { await act(async () => pending[index].resolve(value)); }
function mount() { return render(<AgentActivityProvider><View /></AgentActivityProvider>); }

beforeEach(() => {
  localStorage.clear();
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
