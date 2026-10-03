import { describe, it, expect, vi } from 'vitest';
import type { Session } from '../pages/workspace/types';
import { connectResolvedTerminal, muxKindOfServer, resolveTerminalOpen, settlePendingOpens, PENDING_TERMINAL_OPEN_TTL_MS } from './terminalTargetOpen';

const MISAO_REF = '{"kind":"misao","workspace":"azito","window":"w_01M40229BC46M2RPATEBX4JN25"}';
const sessions: Session[] = [{ name: 'azito', windows: [{ index: 0, name: 'win', panes: [], ref: MISAO_REF, windowId: 843 }] }];
const servers = [{ name: 'tmuxsrv', muxRuntime: 'system' as const }, { name: 'misaosrv', muxRuntime: 'misao' as const }];

describe('muxKindOfServer', () => {
  it('maps the runtime to a kind and is undefined for an unknown server', () => {
    expect(muxKindOfServer(servers, 'tmuxsrv')).toBe('tmux');
    expect(muxKindOfServer(servers, 'misaosrv')).toBe('misao');
    expect(muxKindOfServer(servers, 'nope')).toBeUndefined();
    expect(muxKindOfServer([{ name: 'legacy' }], 'legacy')).toBe('tmux');
  });
});

describe('resolveTerminalOpen', () => {
  it('opens by windowId when the request carries one, whatever the server kind', () => {
    expect(resolveTerminalOpen({ serverName: 'misaosrv', target: 'azito:win', windowId: 843 }, { muxKind: 'misao' }))
      .toEqual({ status: 'ready', ref: { kind: 'windowId', serverName: 'misaosrv', windowId: 843, pane: 1 } });
  });

  it('keeps the tmux behaviour for a target string on a tmux server', () => {
    const r = resolveTerminalOpen({ serverName: 'tmuxsrv', target: 'azito:win' }, { muxKind: 'tmux' });
    expect(r).toMatchObject({ status: 'ready', ref: { kind: 'ref', serverName: 'tmuxsrv', pane: 1 } });
  });

  it('does not make a tmux ref for a target string on a misao server', () => {
    expect(resolveTerminalOpen({ serverName: 'misaosrv', target: 'azito:win' }, { muxKind: 'misao' })).toEqual({ status: 'wait' });
    expect(resolveTerminalOpen({ serverName: 'misaosrv', target: 'azito:win' }, { muxKind: 'misao', sessions }))
      .toEqual({ status: 'ready', ref: { kind: 'windowId', serverName: 'misaosrv', windowId: 843, pane: 1 } });
  });
});

describe('connectResolvedTerminal', () => {
  it('connects when resolved and logs without connecting when not', () => {
    const connect = vi.fn();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    connectResolvedTerminal({ serverName: 'misaosrv', target: 'azito:win' }, { muxKind: 'misao' }, connect, 3);
    expect(connect).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    connectResolvedTerminal({ serverName: 'misaosrv', target: 'x', windowId: 9 }, { muxKind: 'misao' }, connect, 3);
    expect(connect).toHaveBeenCalledWith({ kind: 'windowId', serverName: 'misaosrv', windowId: 9, pane: 1 }, 3);
    error.mockRestore();
  });
});

describe('settlePendingOpens', () => {
  const entry = (serverName: string, target: string, at = 0) => ({ req: { serverName, target }, at });

  it('keeps waiting until the server list and sessions arrive, then opens', () => {
    const pending = [entry('misaosrv', 'azito:win')];
    expect(settlePendingOpens(pending, [], {}, 1).waiting).toHaveLength(1);
    expect(settlePendingOpens(pending, servers, {}, 1).waiting).toHaveLength(1);
    const done = settlePendingOpens(pending, servers, { misaosrv: sessions }, 1);
    expect(done.open).toEqual([{ entry: pending[0], ref: { kind: 'windowId', serverName: 'misaosrv', windowId: 843, pane: 1 } }]);
  });

  it('fails a target the loaded sessions do not list, and an entry that waited too long', () => {
    expect(settlePendingOpens([entry('misaosrv', 'azito:gone')], servers, { misaosrv: sessions }, 1).failed).toHaveLength(1);
    expect(settlePendingOpens([entry('misaosrv', 'azito:win')], [], {}, PENDING_TERMINAL_OPEN_TTL_MS + 1).failed).toHaveLength(1);
  });

  it('opens a tmux target as soon as the server list reports it', () => {
    expect(settlePendingOpens([entry('tmuxsrv', 'azito:win')], servers, {}, 1).open).toHaveLength(1);
  });
});
