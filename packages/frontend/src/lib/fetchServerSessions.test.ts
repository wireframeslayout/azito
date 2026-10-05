import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../api/client', () => ({ api: vi.fn() }));

import { api } from '../api/client';
import { fetchSessionListing, fetchSessionsForServers, keepUnavailableKinds } from './fetchServerSessions';
import type { Session } from '../pages/workspace/types';

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

describe('fetchSessionListing / keepUnavailableKinds (#311)', () => {
  beforeEach(() => apiMock.mockReset());

  const misaoRef = JSON.stringify({ kind: 'misao', workspace: 'dev', window: 'w_01M40229BC46M2RPATEBX4JN25' });
  const tmuxDev: Session = { name: 'dev', kind: 'tmux', windows: [] };
  const misaoDev: Session = { name: 'dev', kind: 'misao', windows: [{ index: 0, name: 'main', panes: [], ref: misaoRef, windowId: 5 }] };

  it('asks for the detailed listing and refuses an error body', async () => {
    respondByPath(async (path) => (path.endsWith('?detail=1') ? { sessions: [tmuxDev], unavailable: [] } : { error: 'x' }));
    expect(await fetchSessionListing('local')).toEqual({ sessions: [tmuxDev], unavailable: [] });
    respondByPath(async () => ({ error: 'agent_unreachable' }));
    await expect(fetchSessionListing('local')).rejects.toThrow();
  });

  it('keeps the previous sessions of a mux that could not be listed, so its windows do not read as deleted', () => {
    const listing = { sessions: [tmuxDev], unavailable: [{ kind: 'misao' as const, reason: 'daemon_unreachable' }] };
    expect(keepUnavailableKinds([tmuxDev, misaoDev], listing)).toEqual([tmuxDev, { ...misaoDev, stale: true }]);
  });

  it('takes the listing as is when every mux answered', () => {
    expect(keepUnavailableKinds([tmuxDev, misaoDev], { sessions: [tmuxDev], unavailable: [] })).toEqual([tmuxDev]);
  });
});
