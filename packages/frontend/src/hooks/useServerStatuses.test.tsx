import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ServerStatusProvider, useServerStatuses } from './useServerStatuses';

const mocks = vi.hoisted(() => ({ servers: vi.fn(), status: vi.fn() }));
vi.mock('../api/client', () => ({
  api: (path: string) => mocks.status(path),
  apiWithStatus: () => mocks.servers(),
}));

const wrapper = ({ children }: { children: ReactNode }) => <ServerStatusProvider>{children}</ServerStatusProvider>;
const server = (name: string, defaultMux: 'tmux' | 'misao') => ({ name, type: 'local', defaultMux });

beforeEach(() => {
  sessionStorage.clear();
  mocks.servers.mockReset();
  mocks.status.mockReset();
});
afterEach(() => sessionStorage.clear());

it('drops the mux details of a cached status until the server is probed again', () => {
  sessionStorage.setItem('server-status-cache-v1', JSON.stringify({
    servers: [server('local', 'misao')],
    statuses: { local: { status: 'online', mux: { misao: { available: true, version: '0.3.0' } } } },
  }));
  mocks.servers.mockReturnValue(new Promise(() => {}));
  const { result } = renderHook(() => useServerStatuses(), { wrapper });
  expect(result.current.statuses.local.status).toBe('online');
  expect(result.current.statuses.local.mux).toBeUndefined();
});

it('puts back to checking only the server whose settings changed', async () => {
  mocks.servers.mockResolvedValue({ status: 200, body: [server('a', 'misao'), server('b', 'tmux')] });
  mocks.status.mockResolvedValue({ status: 'online' });
  const { result } = renderHook(() => useServerStatuses(), { wrapper });
  await waitFor(() => expect(result.current.statuses.a?.status).toBe('online'));
  await waitFor(() => expect(result.current.statuses.b?.status).toBe('online'));

  mocks.servers.mockResolvedValue({ status: 200, body: [server('a', 'tmux'), server('b', 'tmux')] });
  mocks.status.mockReturnValue(new Promise(() => {}));
  await act(async () => { await result.current.refresh(); });
  expect(result.current.statuses.a.status).toBe('checking');
  expect(result.current.statuses.b.status).toBe('online');
});
