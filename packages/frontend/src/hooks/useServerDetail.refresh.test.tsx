import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useServerDetail } from './useServerDetail';

const mocks = vi.hoisted(() => ({ status: 'online', listing: vi.fn(), detail: vi.fn() }));
vi.mock('./useServerStatuses', () => ({ useServerStatuses: () => ({
  servers: [{ name: 'a', type: 'agent' }], statuses: { a: { status: mocks.status } },
  refresh: refreshStatuses,
}) }));
async function refreshStatuses() { return [{ name: 'a', type: 'agent' }]; }
vi.mock('../lib/fetchServerSessions', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/fetchServerSessions')>(), fetchSessionListing: mocks.listing,
}));
vi.mock('../api/client', () => ({
  api: vi.fn(async (path: string) => path.includes('install-status') ? {} : []),
  apiWithStatus: mocks.detail,
}));

beforeEach(() => {
  mocks.status = 'online';
  mocks.listing.mockReset().mockResolvedValue({ sessions: [{ name: 'one', windows: [], windowCount: 0 }], unavailable: [] });
  mocks.detail.mockReset().mockResolvedValue({ status: 200, body: { mux: { driverAvailable: true }, isolationReport: null, isolationCleanupReport: null } });
});

it('invalidates old results on disconnect and fetches again after reconnect', async () => {
  const { result, rerender } = renderHook(() => useServerDetail('a'));
  await waitFor(() => expect(result.current.sessionsState).toBe('ready'));
  expect(result.current.muxDriverStatus).toBe('ok');
  act(() => { mocks.status = 'offline'; rerender(); });
  expect(result.current.sessionsState).toBe('error');
  expect(result.current.sessionsReason).toBe('agent_unreachable');
  expect(result.current.muxFetchState).toBe('error');
  expect(result.current.sessions[0].stale).toBe(true);
  act(() => { mocks.status = 'checking'; rerender(); });
  act(() => { mocks.status = 'online'; rerender(); });
  await waitFor(() => expect(result.current.sessionsState).toBe('ready'));
  expect(result.current.muxDriverStatus).toBe('ok');
  expect(mocks.listing).toHaveBeenCalledTimes(2);
});

it('ignores an old listing after disconnect and keeps partial failure reasons', async () => {
  let resolveOld!: (value: unknown) => void;
  mocks.listing.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
  const { result, rerender, unmount } = renderHook(() => useServerDetail('a'));
  act(() => { mocks.status = 'offline'; rerender(); });
  await act(async () => resolveOld({ sessions: [{ name: 'old', windows: [] }], unavailable: [] }));
  expect(result.current.sessionsState).toBe('error');
  mocks.listing.mockResolvedValueOnce({ sessions: [], unavailable: [{ kind: 'misao', reason: 'daemon_unreachable' }], listedKinds: ['tmux'] });
  act(() => { mocks.status = 'online'; rerender(); });
  await waitFor(() => expect(result.current.sessionsState).toBe('partial'));
  expect(result.current.sessionsReason).toBe('daemon_unreachable');
  unmount();
});

it('ignores a response after switching servers', async () => {
  let resolveOld!: (value: unknown) => void;
  mocks.listing.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
  const { result, rerender } = renderHook(({ name }) => useServerDetail(name), { initialProps: { name: 'a' } });
  rerender({ name: 'b' });
  await waitFor(() => expect(result.current.sessionsState).toBe('ready'));
  await act(async () => resolveOld({ sessions: [{ name: 'old', windows: [] }], unavailable: [] }));
  expect(result.current.sessions.map((session) => session.name)).toEqual(['one']);
});
