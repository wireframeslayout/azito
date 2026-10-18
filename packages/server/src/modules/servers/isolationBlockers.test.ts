import { describe, it, expect, vi } from 'vitest';
import type { ServerConfig } from './Server';
import type { IMuxClient } from '../tmux/IMuxClient';
import { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import { checkIsolationBlockers } from './isolationBlockers';
import type { Window } from '../windows/Window';

const MISAO_REF = { kind: 'misao' as const, workspace: 'ws', window: 'w_01M3XFD8H97JCPKS5Y5BH3JZQH' };

function registry(misaoUp: boolean) {
  const r = new MuxDriverRegistry();
  r.register('tmux', { kind: 'tmux', listWorkspacesStrict: vi.fn(async () => []) } as unknown as IMuxClient);
  r.register('misao', { kind: 'misao', listWorkspacesStrict: vi.fn(async () => []) } as unknown as IMuxClient,
    () => (misaoUp ? { available: true } : { available: false, reason: 'daemon_unreachable' }));
  return r;
}

const local = { name: 'local', type: 'local', defaultMux: 'tmux' } as ServerConfig;
const terminalRow = (muxRef?: Window['muxRef']) => ({ id: 1, windowType: 'terminal', taskId: null, muxRef } as Window);

// The isolation gate fails closed on a mux it cannot list (#311): listWorkspacesStrict only calls the usable muxes.
describe('checkIsolationBlockers with a stopped misao daemon', () => {
  it('blocks (409) when a window row of the server lives in the stopped mux', async () => {
    const result = await checkIsolationBlockers(
      { windowRepo: { findByServer: () => [terminalRow(MISAO_REF)] }, muxDriverRegistry: registry(false) }, 'local', local);
    expect(result).toMatchObject({ status: 409, body: { error: 'isolation_intent_blocked_by_session_check_failure' } });
    expect(result!.body.message).toContain('misao: daemon_unreachable');
  });

  it('does not block on a stopped mux the server has no window in and that is not its default', async () => {
    const result = await checkIsolationBlockers(
      { windowRepo: { findByServer: () => [terminalRow({ kind: 'tmux', workspace: 's', window: 'w' })] }, muxDriverRegistry: registry(false) }, 'local', local);
    expect(result).toBeNull();
  });
});
