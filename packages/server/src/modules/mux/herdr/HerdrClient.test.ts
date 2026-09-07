import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HerdrClient } from './HerdrClient';
import { MuxCapabilityMissingError } from '../../tmux/MuxCapabilityError';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import type { MuxRef } from '@azito/shared';

const SNAPSHOT = {
  session: 'azito',
  workspaces: [
    {
      id: 'ws1',
      name: 'default',
      tabs: [
        {
          id: 'tab1',
          name: 'main',
          active: true,
          panes: [
            { id: 'p1', index: 0, command: 'bash', title: '', width: 120, height: 40, active: true, pid: 1001, cwd: '/home/user' },
            { id: 'p2', index: 1, command: 'vim', title: 'file.ts', width: 60, height: 40, active: false, pid: 1002, cwd: '/home/user' },
          ],
        },
        {
          id: 'tab2',
          name: 'build',
          active: false,
          panes: [
            { id: 'p3', index: 0, command: 'npm', title: 'npm run dev', width: 120, height: 40, active: true, pid: 1003, cwd: '/home/user/proj' },
          ],
        },
      ],
    },
  ],
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
    it('outputStream is false', () => expect(client.caps.outputStream).toBe(false));
    it('agentState is true', () => expect(client.caps.agentState).toBe(true));
    it('changeEvents is true', () => expect(client.caps.changeEvents).toBe(true));
    it('zoom is false', () => expect(client.caps.zoom).toBe(false));
    it('layoutSnapshot is false', () => expect(client.caps.layoutSnapshot).toBe(false));
  });

  describe('listWorkspaces', () => {
    it('returns MuxWorkspace array from snapshot', async () => {
      const client = makeClient((method) => {
        if (method === 'session.snapshot') return SNAPSHOT;
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
    it('calls workspace.create and returns ref', async () => {
      const client = makeClient((method) => {
        if (method === 'workspace.create') return { id: 'ws2', name: 'new-ws', tab: { id: 'tab3', name: 'default' } };
        return null;
      });
      const { ref } = await client.openWorkspace(server, 'new-ws');
      expect(ref).toEqual({ kind: 'herdr', workspace: 'new-ws', window: 'default' });
    });
  });

  describe('openWindow', () => {
    it('calls tab.create with workspace_id', async () => {
      let capturedParams: unknown;
      const client = makeClient((method, params) => {
        if (method === 'session.snapshot') return SNAPSHOT;
        if (method === 'tab.create') {
          capturedParams = params;
          return { id: 'tab4', name: 'new-tab' };
        }
        return null;
      });
      const { ref } = await client.openWindow(server, 'default', 'new-tab', { extraEnv: { FOO: 'bar' } });
      expect(ref).toEqual({ kind: 'herdr', workspace: 'default', window: 'new-tab' });
      expect(capturedParams).toEqual({ workspace_id: 'ws1', name: 'new-tab', env: { FOO: 'bar' } });
    });
  });

  describe('resolvePane', () => {
    it('returns handle for ordinal 1', async () => {
      const client = makeClient((method) => method === 'session.snapshot' ? SNAPSHOT : null);
      const ref: MuxRef = { kind: 'herdr', workspace: 'default', window: 'main' };
      const handle = await client.resolvePane(server, ref, 1);
      expect(handle as string).toBe('ws1:p1');
    });

    it('throws for out-of-range ordinal', async () => {
      const client = makeClient((method) => method === 'session.snapshot' ? SNAPSHOT : null);
      const ref: MuxRef = { kind: 'herdr', workspace: 'default', window: 'main' };
      await expect(client.resolvePane(server, ref, 5)).rejects.toThrow('out of range');
    });
  });

  describe('refFromPaneHandle', () => {
    it('resolves a pane handle back to ref+ordinal', async () => {
      const client = makeClient((method) => method === 'session.snapshot' ? SNAPSHOT : null);
      const result = await client.refFromPaneHandle(server, 'ws1:p2' as any);
      expect(result).toEqual({
        ref: { kind: 'herdr', workspace: 'default', window: 'main' },
        ordinal: 2,
      });
    });

    it('returns null for unknown pane', async () => {
      const client = makeClient((method) => method === 'session.snapshot' ? SNAPSHOT : null);
      const result = await client.refFromPaneHandle(server, 'ws1:p999' as any);
      expect(result).toBeNull();
    });
  });

  describe('sendKeysToHandle', () => {
    it('converts tmux keys to herdr keys', async () => {
      let sentKeys: unknown;
      const client = makeClient((method, params) => {
        if (method === 'session.snapshot') return SNAPSHOT;
        if (method === 'pane.send_keys') { sentKeys = (params as any).keys; return null; }
        return null;
      });
      await client.sendKeysToHandle(server, 'ws1:p1' as any, ['C-c', 'Enter']);
      expect(sentKeys).toEqual(['ctrl+c', 'enter']);
    });
  });

  describe('captureScreen', () => {
    it('returns pane content as stdout', async () => {
      const client = makeClient((method) => {
        if (method === 'pane.read') return { content: 'hello world\n' };
        return null;
      });
      const result = await client.captureScreen(server, 'ws1:p1' as any);
      expect(result.stdout).toBe('hello world\n');
      expect(result.code).toBe(0);
    });
  });

  describe('closeWindow', () => {
    it('calls tab.close with resolved tab_id', async () => {
      let closedTabId: string | undefined;
      const client = makeClient((method, params) => {
        if (method === 'session.snapshot') return SNAPSHOT;
        if (method === 'tab.close') { closedTabId = (params as any).tab_id; return null; }
        return null;
      });
      await client.closeWindow(server, { kind: 'herdr', workspace: 'default', window: 'main' });
      expect(closedTabId).toBe('tab1');
    });
  });

  describe('splitPaneByHandle', () => {
    it('returns new pane handle', async () => {
      const client = makeClient((method) => {
        if (method === 'pane.split') return { id: 'p4' };
        return null;
      });
      const { handle } = await client.splitPaneByHandle(server, 'ws1:p1' as any, 'v');
      expect(handle as string).toBe('ws1:p4');
    });
  });

  describe('panePidByHandle', () => {
    it('returns pid from snapshot', async () => {
      const client = makeClient((method) => method === 'session.snapshot' ? SNAPSHOT : null);
      expect(await client.panePidByHandle(server, 'ws1:p1' as any)).toBe(1001);
    });

    it('returns null for unknown pane', async () => {
      const client = makeClient((method) => method === 'session.snapshot' ? SNAPSHOT : null);
      expect(await client.panePidByHandle(server, 'ws1:p999' as any)).toBeNull();
    });
  });

  describe('capability-gated methods throw MuxCapabilityMissingError', () => {
    const client = makeClient(() => null);
    const ref: MuxRef = { kind: 'herdr', workspace: 'ws', window: 'w' };

    it('startOutputStream', () => expect(client.startOutputStream(server, 'h' as any, '/tmp/x')).rejects.toBeInstanceOf(MuxCapabilityMissingError));
    it('stopOutputStream', () => expect(client.stopOutputStream(server, 'h' as any)).rejects.toBeInstanceOf(MuxCapabilityMissingError));
    it('zoomPaneByHandle', () => expect(client.zoomPaneByHandle(server, 'h' as any)).rejects.toBeInstanceOf(MuxCapabilityMissingError));
    it('unzoomPaneByHandle', () => expect(client.unzoomPaneByHandle(server, 'h' as any)).rejects.toBeInstanceOf(MuxCapabilityMissingError));
    it('isPaneInModeByHandle', () => expect(client.isPaneInModeByHandle(server, 'h' as any)).rejects.toBeInstanceOf(MuxCapabilityMissingError));
    it('cancelPaneModeByHandle', () => expect(client.cancelPaneModeByHandle(server, 'h' as any)).rejects.toBeInstanceOf(MuxCapabilityMissingError));
    it('setPaneTitle', () => expect(client.setPaneTitle(server, 'h' as any, 'x')).rejects.toBeInstanceOf(MuxCapabilityMissingError));
    it('windowActivity', () => expect(client.windowActivity(server, ref)).rejects.toBeInstanceOf(MuxCapabilityMissingError));
    it('captureLayout', () => expect(client.captureLayout(server, ref)).rejects.toBeInstanceOf(MuxCapabilityMissingError));
    it('applyLayout', () => expect(client.applyLayout(server, ref, '')).rejects.toBeInstanceOf(MuxCapabilityMissingError));

    it('MuxCapabilityMissingError carries correct capability name', async () => {
      try { await client.startOutputStream(server, 'h' as any, '/tmp'); } catch (e) {
        expect((e as MuxCapabilityMissingError).capability).toBe('outputStream');
      }
      try { await client.zoomPaneByHandle(server, 'h' as any); } catch (e) {
        expect((e as MuxCapabilityMissingError).capability).toBe('zoom');
      }
    });
  });

  describe('measurePanePids', () => {
    it('collects all pane PIDs', async () => {
      const client = makeClient((method) => method === 'session.snapshot' ? SNAPSHOT : null);
      const pids = await client.measurePanePids(server);
      expect(pids).toHaveLength(3);
      expect(pids.map(p => p.pid)).toEqual([1001, 1002, 1003]);
    });
  });

  describe('listAllPanes', () => {
    it('returns all panes across workspaces', async () => {
      const client = makeClient((method) => method === 'session.snapshot' ? SNAPSHOT : null);
      const panes = await client.listAllPanes(server);
      expect(panes).toHaveLength(3);
      expect(panes[0].paneId).toBe('ws1:p1');
      expect(panes[0].sessionName).toBe('default');
      expect(panes[0].windowName).toBe('main');
    });
  });

  describe('windowExists', () => {
    const client = makeClient((method) => method === 'session.snapshot' ? SNAPSHOT : null);
    it('returns true for existing tab', async () => {
      expect(await client.windowExists(server, { kind: 'herdr', workspace: 'default', window: 'main' })).toBe(true);
    });
    it('returns false for missing tab', async () => {
      expect(await client.windowExists(server, { kind: 'herdr', workspace: 'default', window: 'nonexist' })).toBe(false);
    });
  });
});
