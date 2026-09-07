import { describe, it, expect, vi } from 'vitest';
import { HerdrClient } from './HerdrClient';
import { MuxCapabilityMissingError } from '../../tmux/MuxCapabilityError';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import type { MuxRef } from '@azito/shared';

const SNAPSHOT = {
  focused_workspace_id: 'w1',
  focused_tab_id: 'w1:t1',
  focused_pane_id: 'w1:p1',
  workspaces: [
    { workspace_id: 'w1', number: 1, label: 'default', focused: true, pane_count: 3, tab_count: 2, active_tab_id: 'w1:t1', agent_status: 'unknown' },
  ],
  tabs: [
    { tab_id: 'w1:t1', workspace_id: 'w1', number: 1, label: 'main', focused: true, pane_count: 2, agent_status: 'unknown' },
    { tab_id: 'w1:t2', workspace_id: 'w1', number: 2, label: 'build', focused: false, pane_count: 1, agent_status: 'unknown' },
  ],
  panes: [
    { pane_id: 'w1:p1', terminal_id: 1, workspace_id: 'w1', tab_id: 'w1:t1', focused: true, cwd: '/home/user', foreground_cwd: '/home/user', agent_status: 'unknown', revision: 5 },
    { pane_id: 'w1:p2', terminal_id: 2, workspace_id: 'w1', tab_id: 'w1:t1', focused: false, cwd: '/home/user', foreground_cwd: '/home/user', agent_status: 'unknown', revision: 3 },
    { pane_id: 'w1:p3', terminal_id: 3, workspace_id: 'w1', tab_id: 'w1:t2', focused: true, cwd: '/home/user/proj', foreground_cwd: '/home/user/proj', agent_status: 'unknown', revision: 1 },
  ],
  layouts: [
    { workspace_id: 'w1', tab_id: 'w1:t1', zoomed: false, focused_pane_id: 'w1:p1', panes: [{ pane_id: 'w1:p1', focused: true, rect: { x: 0, y: 0, width: 120, height: 40 } }, { pane_id: 'w1:p2', focused: false, rect: { x: 0, y: 40, width: 60, height: 20 } }], splits: [] },
    { workspace_id: 'w1', tab_id: 'w1:t2', zoomed: false, focused_pane_id: 'w1:p3', panes: [{ pane_id: 'w1:p3', focused: true, rect: { x: 0, y: 0, width: 120, height: 40 } }], splits: [] },
  ],
  agents: [],
};

function makeClient(handler: (method: string, params: unknown) => unknown) {
  const execMux = vi.fn(async (req: { kind: string; method: string; params: unknown }) => {
    const result = handler(req.method, req.params);
    return { stdout: JSON.stringify(result), stderr: '', code: 0 };
  });
  const factory = {
    getTransport: () => ({ execMux, openTerminal: vi.fn() }),
  } as unknown as TransportFactory;
  return new HerdrClient(factory, 'azito');
}

const server = { name: 'server007-herdr', type: 'agent' as const, muxRuntime: 'herdr' as const } as any;

describe('HerdrClient', () => {
  describe('kind and caps', () => {
    const client = makeClient(() => null);
    it('kind is herdr', () => expect(client.kind).toBe('herdr'));
    it('outputStream is true', () => expect(client.caps.outputStream).toBe(true));
    it('agentState is true', () => expect(client.caps.agentState).toBe(true));
    it('changeEvents is true', () => expect(client.caps.changeEvents).toBe(true));
    it('zoom is true', () => expect(client.caps.zoom).toBe(true));
    it('paneTitle is true', () => expect(client.caps.paneTitle).toBe(true));
    it('layoutSnapshot is true', () => expect(client.caps.layoutSnapshot).toBe(true));
    it('copyMode is false', () => expect(client.caps.copyMode).toBe(false));
    it('stablePaneHandle is true', () => expect(client.caps.stablePaneHandle).toBe(true));
  });

  describe('listWorkspaces', () => {
    it('returns MuxWorkspace array from snapshot', async () => {
      const client = makeClient((method) => {
        if (method === 'session.snapshot') return { type: 'session_snapshot', snapshot: SNAPSHOT };
        return null;
      });
      const workspaces = await client.listWorkspaces(server);
      expect(workspaces).toHaveLength(1);
      expect(workspaces[0].name).toBe('default');
      expect(workspaces[0].windowCount).toBe(2);
      expect(workspaces[0].windows).toHaveLength(2);
      expect(workspaces[0].windows[0].name).toBe('main');
      expect(workspaces[0].windows[0].panes).toHaveLength(2);
    });
  });

  describe('openWorkspace', () => {
    it('calls workspace.create, workspace.rename, tab.rename and returns ref', async () => {
      const calls: string[] = [];
      const client = makeClient((method) => {
        calls.push(method);
        if (method === 'workspace.create') return { type: 'workspace_created', workspace: { workspace_id: 'w2', label: 'azito' }, tab: { tab_id: 'w2:t1', label: '1' }, root_pane: { pane_id: 'w2:p1' } };
        if (method === 'workspace.rename') return { type: 'ok' };
        if (method === 'tab.rename') return { type: 'ok' };
        return null;
      });
      const { ref } = await client.openWorkspace(server, 'new-ws');
      expect(ref).toEqual({ kind: 'herdr', workspace: 'new-ws', window: 'default' });
      expect(calls).toEqual(['workspace.create', 'workspace.rename', 'tab.rename']);
    });
  });

  describe('openWindow', () => {
    it('calls tab.create + tab.rename with workspace_id', async () => {
      let tabCreateParams: unknown;
      const client = makeClient((method, params) => {
        if (method === 'session.snapshot') return { type: 'session_snapshot', snapshot: SNAPSHOT };
        if (method === 'tab.create') {
          tabCreateParams = params;
          return { type: 'tab_created', tab: { tab_id: 'w1:t3', label: '3' }, root_pane: { pane_id: 'w1:p4' } };
        }
        if (method === 'tab.rename') return { type: 'ok' };
        return null;
      });
      const { ref } = await client.openWindow(server, 'default', 'new-tab', { extraEnv: { FOO: 'bar' } });
      expect(ref).toEqual({ kind: 'herdr', workspace: 'default', window: 'new-tab' });
      expect(tabCreateParams).toEqual({ workspace_id: 'w1', env: { FOO: 'bar' } });
    });
  });

  describe('resolvePane', () => {
    it('returns handle for ordinal 1', async () => {
      const client = makeClient((method) => method === 'session.snapshot' ? { type: 'session_snapshot', snapshot: SNAPSHOT } : { type: 'ok' });
      const ref: MuxRef = { kind: 'herdr', workspace: 'default', window: 'main' };
      const handle = await client.resolvePane(server, ref, 1);
      expect(handle as string).toBe('w1:p1');
    });

    it('throws for out-of-range ordinal', async () => {
      const client = makeClient((method) => method === 'session.snapshot' ? { type: 'session_snapshot', snapshot: SNAPSHOT } : { type: 'ok' });
      const ref: MuxRef = { kind: 'herdr', workspace: 'default', window: 'main' };
      await expect(client.resolvePane(server, ref, 5)).rejects.toThrow('out of range');
    });
  });

  describe('refFromPaneHandle', () => {
    it('resolves a pane handle back to ref+ordinal', async () => {
      const client = makeClient((method) => method === 'session.snapshot' ? { type: 'session_snapshot', snapshot: SNAPSHOT } : { type: 'ok' });
      const result = await client.refFromPaneHandle(server, 'w1:p2' as any);
      expect(result).toEqual({
        ref: { kind: 'herdr', workspace: 'default', window: 'main' },
        ordinal: 2,
      });
    });

    it('returns null for unknown pane', async () => {
      const client = makeClient((method) => method === 'session.snapshot' ? { type: 'session_snapshot', snapshot: SNAPSHOT } : { type: 'ok' });
      const result = await client.refFromPaneHandle(server, 'w1:p999' as any);
      expect(result).toBeNull();
    });
  });

  describe('sendKeysToHandle', () => {
    it('converts tmux keys to herdr keys and sends one per call', async () => {
      const sentKeys: string[] = [];
      const client = makeClient((method, params) => {
        if (method === 'pane.send_keys') { sentKeys.push(...((params as any).keys as string[])); return { type: 'ok' }; }
        return { type: 'ok' };
      });
      await client.sendKeysToHandle(server, 'w1:p1' as any, ['C-c', 'Enter']);
      expect(sentKeys).toEqual(['ctrl+c', 'enter']);
    });
  });

  describe('captureScreen', () => {
    it('returns pane text as stdout', async () => {
      const client = makeClient((method) => {
        if (method === 'pane.read') return { type: 'pane_read', read: { pane_id: 'w1:p1', source: 'recent', format: 'text', text: 'hello world\n', revision: 5, truncated: false } };
        return { type: 'ok' };
      });
      const result = await client.captureScreen(server, 'w1:p1' as any);
      expect(result.stdout).toBe('hello world\n');
      expect(result.code).toBe(0);
    });
  });

  describe('closeWindow', () => {
    it('calls tab.close with resolved tab_id', async () => {
      let closedTabId: string | undefined;
      const client = makeClient((method, params) => {
        if (method === 'session.snapshot') return { type: 'session_snapshot', snapshot: SNAPSHOT };
        if (method === 'tab.close') { closedTabId = (params as any).tab_id; return { type: 'ok' }; }
        return { type: 'ok' };
      });
      await client.closeWindow(server, { kind: 'herdr', workspace: 'default', window: 'main' });
      expect(closedTabId).toBe('w1:t1');
    });
  });

  describe('splitPaneByHandle', () => {
    it('returns new pane handle', async () => {
      const client = makeClient((method) => {
        if (method === 'pane.split') return { type: 'pane_split', pane: { pane_id: 'w1:p4' } };
        return { type: 'ok' };
      });
      const { handle } = await client.splitPaneByHandle(server, 'w1:p1' as any, 'v');
      expect(handle as string).toBe('w1:p4');
    });
  });

  describe('panePidByHandle', () => {
    it('returns pid from pane.process_info', async () => {
      const client = makeClient((method) => {
        if (method === 'pane.process_info') return { type: 'process_info', pid: 1001, foreground_pid: 1002, foreground_command: 'vim' };
        return { type: 'ok' };
      });
      expect(await client.panePidByHandle(server, 'w1:p1' as any)).toBe(1002);
    });

    it('returns null on error', async () => {
      const client = makeClient((method) => {
        if (method === 'pane.process_info') throw new Error('not found');
        return { type: 'ok' };
      });
      expect(await client.panePidByHandle(server, 'w1:p999' as any)).toBeNull();
    });
  });

  describe('zoomPaneByHandle', () => {
    it('calls pane.zoom', async () => {
      let zoomed = false;
      const client = makeClient((method) => {
        if (method === 'pane.zoom') { zoomed = true; return { type: 'ok' }; }
        return { type: 'ok' };
      });
      await client.zoomPaneByHandle(server, 'w1:p1' as any);
      expect(zoomed).toBe(true);
    });
  });

  describe('setPaneTitle', () => {
    it('calls pane.rename', async () => {
      let renamed: unknown;
      const client = makeClient((method, params) => {
        if (method === 'pane.rename') { renamed = params; return { type: 'ok' }; }
        return { type: 'ok' };
      });
      await client.setPaneTitle(server, 'w1:p1' as any, 'my-title');
      expect(renamed).toEqual({ pane_id: 'w1:p1', label: 'my-title' });
    });
  });

  describe('capability-gated methods that still throw MuxCapabilityMissingError', () => {
    const client = makeClient(() => ({ type: 'ok' }));
    const ref: MuxRef = { kind: 'herdr', workspace: 'ws', window: 'w' };

    it('startOutputStream is no-op', async () => { await expect(client.startOutputStream(server, 'h' as any, '/tmp/x')).resolves.toBeUndefined(); });
    it('stopOutputStream is no-op', async () => { await expect(client.stopOutputStream(server, 'h' as any)).resolves.toBeUndefined(); });
    it('isPaneInModeByHandle', () => expect(client.isPaneInModeByHandle(server, 'h' as any)).rejects.toBeInstanceOf(MuxCapabilityMissingError));
    it('cancelPaneModeByHandle', () => expect(client.cancelPaneModeByHandle(server, 'h' as any)).rejects.toBeInstanceOf(MuxCapabilityMissingError));
    it('windowActivity', () => expect(client.windowActivity(server, ref)).rejects.toBeInstanceOf(MuxCapabilityMissingError));

    it('MuxCapabilityMissingError carries correct capability name', async () => {
      try { await client.windowActivity(server, ref); } catch (e) {
        expect((e as MuxCapabilityMissingError).capability).toBe('activityCounter');
      }
    });
  });

  describe('listAllPanes', () => {
    it('returns all panes across workspaces', async () => {
      const client = makeClient((method) => method === 'session.snapshot' ? { type: 'session_snapshot', snapshot: SNAPSHOT } : { type: 'ok' });
      const panes = await client.listAllPanes(server);
      expect(panes).toHaveLength(3);
      expect(panes[0].paneId).toBe('w1:p1');
      expect(panes[0].sessionName).toBe('default');
      expect(panes[0].windowName).toBe('main');
    });
  });

  describe('windowExists', () => {
    const client = makeClient((method) => method === 'session.snapshot' ? { type: 'session_snapshot', snapshot: SNAPSHOT } : { type: 'ok' });
    it('returns true for existing tab', async () => {
      expect(await client.windowExists(server, { kind: 'herdr', workspace: 'default', window: 'main' })).toBe(true);
    });
    it('returns false for missing tab', async () => {
      expect(await client.windowExists(server, { kind: 'herdr', workspace: 'default', window: 'nonexist' })).toBe(false);
    });
  });
});

// rc.13 E2E regression: the real transports (LocalTransport / agent POST /api/mux) relay the
// NDJSON envelope `{ id, result }` verbatim, while these tests historically mocked the bare
// payload. `GET /api/servers/:name/sessions` on a herdr server crashed with
// "Cannot read properties of undefined (reading 'workspaces')". rpc() must accept both shapes.
describe('HerdrClient rpc envelope unwrapping', () => {
  it('unwraps { id, result } envelopes relayed by the transport', async () => {
    const SNAP = { version: '0.8.2', protocol: 20, workspaces: [{ workspace_id: 'w1', number: 1, label: 'azito', focused: true, pane_count: 1, tab_count: 1, active_tab_id: 'w1:t1', agent_status: 'unknown' }], tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', number: 1, label: '1', focused: true, pane_count: 1, agent_status: 'unknown' }], panes: [{ pane_id: 'w1:p1', terminal_id: 't', workspace_id: 'w1', tab_id: 'w1:t1', focused: true, cwd: '/', foreground_cwd: '/', agent_status: 'unknown', scroll: { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 1 }, revision: 0 }], layouts: [], agents: [] };
    const transport = { execMux: async () => ({ stdout: JSON.stringify({ id: '1', result: { type: 'session_snapshot', snapshot: SNAP } }), stderr: '', code: 0 }) };
    const client = new HerdrClient({ getTransport: () => transport } as never);
    const ws = await client.listWorkspaces({ name: 's', type: 'agent', muxRuntime: 'herdr' } as never);
    expect(ws.map((w) => w.name)).toEqual(['azito']);
    expect(ws[0].windows.map((w) => w.name)).toEqual(['1']);
  });
});

// rc.16 E2E: the worker launch command was sent through pane.send_keys and herdr rejected it
// with invalid_key, so tasks on a herdr server never started (and the failure was swallowed).
describe('HerdrClient sendKeysToHandle text/key split', () => {
  it('sends literal text via pane.send_text and key names via pane.send_keys', async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const transport = { execMux: async (req: { method: string; params: unknown }) => { calls.push({ method: req.method, params: req.params }); return { stdout: JSON.stringify({ id: '1', result: { type: 'ok' } }), stderr: '', code: 0 }; } };
    const client = new HerdrClient({ getTransport: () => transport } as never);
    await client.sendKeysToHandle({ name: 's', type: 'agent', muxRuntime: 'herdr' } as never, 'w1:p5' as never, ['node ~/.azito/supervisor.cjs claude --flag', 'Enter', 'C-c']);
    expect(calls.map((c) => c.method)).toEqual(['pane.send_text', 'pane.send_keys', 'pane.send_keys']);
    expect(calls[0].params).toEqual({ pane_id: 'w1:p5', text: 'node ~/.azito/supervisor.cjs claude --flag' });
    expect(calls[1].params).toEqual({ pane_id: 'w1:p5', keys: ['enter'] });
    expect(calls[2].params).toEqual({ pane_id: 'w1:p5', keys: ['ctrl+c'] });
  });
});
