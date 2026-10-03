import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/client', () => ({ api: vi.fn() }));

import { api } from '../api/client';
import { fetchSessionsForServers } from './fetchServerSessions';

const apiMock = vi.mocked(api);
const session = { name: 's', windows: [] };

function respondByPath(handler: (path: string) => Promise<unknown>): void {
  apiMock.mockImplementation(((...args: unknown[]) => handler(String(args[0]))) as typeof api);
}

describe('fetchSessionsForServers', () => {
  beforeEach(() => apiMock.mockReset());

  it('skips servers already known to be offline without requesting them', async () => {
    respondByPath(async () => [session]);
    const res = await fetchSessionsForServers([{ name: 'a' }, { name: 'b' }], (n) => n === 'b');
    expect(apiMock).toHaveBeenCalledTimes(1);
    expect(apiMock.mock.calls[0][0]).toBe('/servers/a/sessions');
    expect(res).toEqual({ data: { a: [session] }, offline: ['b'] });
  });

  it('requests servers in parallel, so one slow server does not delay the others', async () => {
    let releaseSlow: (v: unknown) => void = () => {};
    respondByPath((path) => (
      path.includes('slow') ? new Promise((r) => { releaseSlow = r; }) : Promise.resolve([session])
    ));
    const p = fetchSessionsForServers([{ name: 'slow' }, { name: 'fast' }], () => false);
    expect(apiMock).toHaveBeenCalledTimes(2);
    releaseSlow([session]);
    expect((await p).data).toEqual({ slow: [session], fast: [session] });
  });

  it('marks a 503 agent_unreachable body as offline and drops other failures', async () => {
    respondByPath(async (path) => {
      if (path.includes('dead')) return { error: 'agent_unreachable' };
      if (path.includes('broken')) throw new Error('network');
      return [session];
    });
    const res = await fetchSessionsForServers([{ name: 'dead' }, { name: 'broken' }, { name: 'ok' }], () => false);
    expect(res).toEqual({ data: { ok: [session] }, offline: ['dead'] });
  });
});
