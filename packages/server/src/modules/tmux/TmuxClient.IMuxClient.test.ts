import { describe, it, expect, vi } from 'vitest';
import { TmuxClient } from './TmuxClient';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { MuxRef } from '@azito/shared';

function makeClient(execTmux: (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>) {
  const factory = {
    getTransport: () => ({ execTmux: vi.fn(execTmux) }),
  } as unknown as TransportFactory;
  return new TmuxClient(factory, '', '', '');
}

const server = { name: 'local', type: 'local' as const, muxRuntime: 'system' as const } as any;

describe('TmuxClient IMuxClient', () => {
  describe('resolvePane', () => {
    it('returns the PaneHandle for ordinal 1', async () => {
      const client = makeClient(async () => ({
        stdout: '0\t%0\n1\t%1\n2\t%2\n', stderr: '', code: 0,
      }));
      const ref: MuxRef = { kind: 'tmux', workspace: 'sess', window: 'win' };
      const handle = await client.resolvePane(server, ref, 1);
      expect(handle).toBe('%0');
    });

    it('returns the PaneHandle for ordinal 2', async () => {
      const client = makeClient(async () => ({
        stdout: '0\t%5\n1\t%6\n', stderr: '', code: 0,
      }));
      const ref: MuxRef = { kind: 'tmux', workspace: 'sess', window: 'win' };
      const handle = await client.resolvePane(server, ref, 2);
      expect(handle).toBe('%6');
    });

    it('throws for out-of-range ordinal', async () => {
      const client = makeClient(async () => ({
        stdout: '0\t%0\n', stderr: '', code: 0,
      }));
      const ref: MuxRef = { kind: 'tmux', workspace: 'sess', window: 'win' };
      await expect(client.resolvePane(server, ref, 2)).rejects.toThrow('out of range');
    });
  });

  describe('refFromPaneHandle', () => {
    it('resolves a pane handle to MuxRef', async () => {
      const client = makeClient(async () => ({
        stdout: '%0\tsess\twin--abc\t0\tsess\n%1\tsess\twin--abc\t1\tsess\n',
        stderr: '', code: 0,
      }));
      const result = await client.refFromPaneHandle(server, '%1' as any);
      expect(result).toEqual({
        ref: { kind: 'tmux', workspace: 'sess', window: 'win--abc' },
        ordinal: 2,
      });
    });

    it('normalizes linked session via session_group', async () => {
      const client = makeClient(async () => ({
        stdout: '%5\t_azito_sess_3_123\twin--x\t0\tsess\n',
        stderr: '', code: 0,
      }));
      const result = await client.refFromPaneHandle(server, '%5' as any);
      expect(result).toEqual({
        ref: { kind: 'tmux', workspace: 'sess', window: 'win--x' },
        ordinal: 1,
      });
    });

    it('computes ordinal by position among same-window panes (pane_index 1,2)', async () => {
      const client = makeClient(async () => ({
        stdout: '%a\tsess\twin\t1\tsess\n%b\tsess\twin\t2\tsess\n',
        stderr: '', code: 0,
      }));
      expect(await client.refFromPaneHandle(server, '%a' as any)).toEqual({
        ref: { kind: 'tmux', workspace: 'sess', window: 'win' }, ordinal: 1,
      });
      expect(await client.refFromPaneHandle(server, '%b' as any)).toEqual({
        ref: { kind: 'tmux', workspace: 'sess', window: 'win' }, ordinal: 2,
      });
    });

    it('handles gap in pane_index (0,2) → ordinal 1,2', async () => {
      const client = makeClient(async () => ({
        stdout: '%x\tsess\twin\t0\tsess\n%y\tsess\twin\t2\tsess\n',
        stderr: '', code: 0,
      }));
      expect(await client.refFromPaneHandle(server, '%y' as any)).toEqual({
        ref: { kind: 'tmux', workspace: 'sess', window: 'win' }, ordinal: 2,
      });
    });

    it('returns null for unknown handle', async () => {
      const client = makeClient(async () => ({
        stdout: '%0\tsess\twin\t0\tsess\n', stderr: '', code: 0,
      }));
      const result = await client.refFromPaneHandle(server, '%99' as any);
      expect(result).toBeNull();
    });
  });

  describe('captureLayout', () => {
    it('returns layout and pane info', async () => {
      let call = 0;
      const client = makeClient(async () => {
        call++;
        if (call === 1) {
          return { stdout: 'a1b2,80x24,0,0', stderr: '', code: 0 };
        }
        return {
          stdout: '0\tbash\t/home/user\tpane-title\n1\tnode\t/app\tserver\n',
          stderr: '', code: 0,
        };
      });
      const ref: MuxRef = { kind: 'tmux', workspace: 'sess', window: 'win' };
      const result = await client.captureLayout(server, ref);

      expect(result.layout).toBe('a1b2,80x24,0,0');
      expect(result.panes).toHaveLength(2);
      expect(result.panes[0]).toEqual({ index: 0, ordinal: 1, command: 'bash', path: '/home/user', title: 'pane-title' });
      expect(result.panes[1]).toEqual({ index: 1, ordinal: 2, command: 'node', path: '/app', title: 'server' });
    });

    it('preserves original pane_index in index field (pane-base-index 1)', async () => {
      let call = 0;
      const client = makeClient(async () => {
        call++;
        if (call === 1) return { stdout: 'layout', stderr: '', code: 0 };
        return { stdout: '1\tbash\t/home\ttitle1\n2\tnode\t/app\ttitle2\n', stderr: '', code: 0 };
      });
      const ref: MuxRef = { kind: 'tmux', workspace: 'sess', window: 'win' };
      const result = await client.captureLayout(server, ref);
      expect(result.panes[0].index).toBe(1);
      expect(result.panes[1].index).toBe(2);
      expect(result.panes[0].ordinal).toBe(1);
      expect(result.panes[1].ordinal).toBe(2);
    });
  });

  describe('measurePanePids', () => {
    it('returns ref/pid pairs, skipping linked sessions', async () => {
      const client = makeClient(async () => ({
        stdout: [
          'sess\twin--a\t100\tsess',
          '_azito_sess_3_123\twin--a\t100\tsess',
          'sess\twin--b\t200\tsess',
        ].join('\n'),
        stderr: '', code: 0,
      }));

      const result = await client.measurePanePids(server);
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        ref: { kind: 'tmux', workspace: 'sess', window: 'win--a' },
        pid: 100,
      });
      expect(result[1]).toEqual({
        ref: { kind: 'tmux', workspace: 'sess', window: 'win--b' },
        pid: 200,
      });
    });

    it('returns empty on failure', async () => {
      const client = makeClient(async () => {
        throw new Error('no server running');
      });
      const result = await client.measurePanePids(server);
      expect(result).toEqual([]);
    });
  });

  describe('splitPaneByHandle', () => {
    it('returns the new pane handle', async () => {
      const client = makeClient(async () => ({
        stdout: '%5\n', stderr: '', code: 0,
      }));
      const result = await client.splitPaneByHandle(server, '%0' as any, 'v');
      expect(result.handle).toBe('%5');
      expect(result.result.code).toBe(0);
    });
  });

  describe('applyLayout', () => {
    it('calls select-layout via runTmuxCommand', async () => {
      const calls: string[][] = [];
      const client = makeClient(async (args) => {
        calls.push(args);
        return { stdout: '', stderr: '', code: 0 };
      });
      const ref: MuxRef = { kind: 'tmux', workspace: 'sess', window: 'win' };
      await client.applyLayout(server, ref, 'layout-string');

      expect(calls[0]).toContain('select-layout');
      expect(calls[0]).toContain('sess:win');
      expect(calls[0]).toContain('layout-string');
    });
  });

  describe('kind and caps', () => {
    it('reports tmux kind with all caps except agentState', () => {
      const client = makeClient(async () => ({ stdout: '', stderr: '', code: 0 }));
      expect(client.kind).toBe('tmux');
      expect(client.caps.outputStream).toBe(true);
      expect(client.caps.agentState).toBe(false);
    });
  });
});
