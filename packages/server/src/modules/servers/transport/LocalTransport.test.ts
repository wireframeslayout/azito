import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  })),
}));

import { LocalTransport } from './LocalTransport';
import { HerdrSocketClient } from '../../mux/herdr/HerdrSocketClient';
import type { MuxRef, PaneOrdinal } from '@azito/shared';
import type { TmuxRuntime } from './TmuxRuntime';

const dummyRuntime: TmuxRuntime = { bin: '/usr/bin/tmux', baseArgs: [] };

function makeSnapshotResult(workspaces: Array<{ workspace_id: string; label: string }>) {
  return {
    snapshot: {
      workspaces,
      tabs: workspaces.map((ws) => ({ tab_id: `tab-${ws.workspace_id}`, workspace_id: ws.workspace_id, label: 'main' })),
      panes: workspaces.map((ws) => ({ pane_id: `pane-${ws.workspace_id}`, tab_id: `tab-${ws.workspace_id}` })),
    },
  };
}

describe('LocalTransport.openHerdrTerminal', () => {
  let mockSocket: HerdrSocketClient;
  let transport: LocalTransport;

  beforeEach(() => {
    mockSocket = {
      sessionName: 'azito',
      socketPath: '/home/user/.config/herdr/sessions/azito/herdr.sock',
      callRpc: vi.fn(),
    } as unknown as HerdrSocketClient;
    transport = new LocalTransport(dummyRuntime, 'http://localhost:3001', mockSocket);
  });

  it('uses injected socket sessionName for HERDR_SESSION env, not ref.workspace', async () => {
    const snap = makeSnapshotResult([{ workspace_id: 'ws1', label: 'win--8u83' }]);
    (mockSocket.callRpc as ReturnType<typeof vi.fn>).mockResolvedValue(snap);

    const spawnSpy = vi.spyOn(transport, 'spawnTerminal').mockReturnValue({
      on: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(),
      emit: vi.fn(),
    } as any);

    const ref: MuxRef = { kind: 'herdr', workspace: 'win--8u83', window: 'main' };
    await transport.openTerminal(ref, 1 as PaneOrdinal, 80, 24);

    expect(spawnSpy).toHaveBeenCalledOnce();
    const env = spawnSpy.mock.calls[0][3] as Record<string, string>;
    expect(env.HERDR_SESSION).toBe('azito');
  });

  it('calls workspace.focus before tab.focus and pane.focus', async () => {
    const snap = makeSnapshotResult([{ workspace_id: 'ws1', label: 'win--x' }]);
    const callOrder: string[] = [];
    (mockSocket.callRpc as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
      callOrder.push(method);
      if (method === 'session.snapshot') return snap;
      return {};
    });

    vi.spyOn(transport, 'spawnTerminal').mockReturnValue({
      on: vi.fn(), write: vi.fn(), resize: vi.fn(), close: vi.fn(), emit: vi.fn(),
    } as any);

    const ref: MuxRef = { kind: 'herdr', workspace: 'win--x', window: 'main' };
    await transport.openTerminal(ref, 1 as PaneOrdinal, 80, 24);

    const focusCalls = callOrder.filter((m) => m.includes('focus'));
    expect(focusCalls).toEqual(['workspace.focus', 'tab.focus', 'pane.focus']);
  });

  it('throws WINDOW_NOT_FOUND when workspace label does not exist in snapshot', async () => {
    const snap = makeSnapshotResult([{ workspace_id: 'ws1', label: 'azito' }]);
    (mockSocket.callRpc as ReturnType<typeof vi.fn>).mockResolvedValue(snap);

    const ref: MuxRef = { kind: 'herdr', workspace: 'nonexistent', window: 'main' };
    await expect(transport.openTerminal(ref, 1 as PaneOrdinal, 80, 24)).rejects.toThrow('WINDOW_NOT_FOUND');
  });

  it('throws WINDOW_NOT_FOUND when snapshot is null', async () => {
    (mockSocket.callRpc as ReturnType<typeof vi.fn>).mockResolvedValue({ snapshot: null });

    const ref: MuxRef = { kind: 'herdr', workspace: 'win--x', window: 'main' };
    await expect(transport.openTerminal(ref, 1 as PaneOrdinal, 80, 24)).rejects.toThrow('WINDOW_NOT_FOUND');
  });

  it('throws when herdr socket is not configured', async () => {
    const transportNoSocket = new LocalTransport(dummyRuntime, 'http://localhost:3001');

    const ref: MuxRef = { kind: 'herdr', workspace: 'win--x', window: 'main' };
    await expect(transportNoSocket.openTerminal(ref, 1 as PaneOrdinal, 80, 24)).rejects.toThrow('herdr socket not configured');
  });
});

describe('HerdrSocketClient.callRpc', () => {
  it('unwraps result envelope from raw herdr response', async () => {
    const rawResponse = {
      id: '1',
      result: {
        type: 'session_snapshot',
        snapshot: { workspaces: [{ workspace_id: 'ws1', label: 'azito' }], tabs: [], panes: [] },
      },
    };
    const sock = { callRpc: HerdrSocketClient.prototype.callRpc, call: vi.fn().mockResolvedValue(rawResponse) } as unknown as HerdrSocketClient;
    const result = await sock.callRpc('session.snapshot');
    expect(result).toEqual(rawResponse.result);
    expect(result.snapshot).toBeDefined();
  });

  it('returns raw response when no result envelope (e.g. pong)', async () => {
    const rawResponse = { type: 'pong', version: '0.8.2' };
    const sock = { callRpc: HerdrSocketClient.prototype.callRpc, call: vi.fn().mockResolvedValue(rawResponse) } as unknown as HerdrSocketClient;
    const result = await sock.callRpc('ping');
    expect(result).toEqual(rawResponse);
  });
});
