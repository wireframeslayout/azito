import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Session } from '../pages/workspace/types';
import { connectResolvedTerminal, muxKindOfServer, resolveTerminalOpen, PendingOpenQueue, PENDING_TERMINAL_OPEN_TTL_MS } from './terminalTargetOpen';

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
  it('connects by ref when resolved, and passes the target string on when not', () => {
    const connect = vi.fn();
    connectResolvedTerminal({ serverName: 'misaosrv', target: 'azito:win' }, { muxKind: 'misao' }, connect, 3);
    expect(connect).toHaveBeenLastCalledWith('misaosrv', 'azito:win', 3);
    connectResolvedTerminal({ serverName: 'misaosrv', target: 'x', windowId: 9 }, { muxKind: 'misao' }, connect, 3);
    expect(connect).toHaveBeenLastCalledWith({ kind: 'windowId', serverName: 'misaosrv', windowId: 9, pane: 1 }, 3);
  });
});

describe('PendingOpenQueue', () => {
  const REQ = { serverName: 'misaosrv', target: 'azito:win' };
  const WINDOW_REF = { kind: 'windowId', serverName: 'misaosrv', windowId: 843, pane: 1 };

  function setup(opts: { servers?: typeof servers; sessions?: Record<string, Session[]>; fetch?: () => Promise<Session[]> } = {}) {
    const state = { servers: opts.servers ?? [], sessions: opts.sessions ?? {} as Record<string, Session[]> };
    const connect = vi.fn();
    const connectByTarget = vi.fn();
    const fetchSessions = vi.fn(opts.fetch ?? (() => new Promise<Session[]>(() => {})));
    const queue = new PendingOpenQueue({
      getServers: () => state.servers,
      getSessions: (name) => state.sessions[name],
      fetchSessions,
      connect,
      connectByTarget,
    });
    return { state, connect, connectByTarget, fetchSessions, queue };
  }

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('connects exactly once after the servers arrive and then the sessions arrive', () => {
    const t = setup();
    t.queue.open(REQ, 4);
    t.state.servers = servers;
    t.queue.notify();
    expect(t.connect).not.toHaveBeenCalled();
    t.state.sessions = { misaosrv: sessions };
    t.queue.notify();
    t.queue.notify();
    vi.advanceTimersByTime(PENDING_TERMINAL_OPEN_TTL_MS * 2);
    expect(t.connect).toHaveBeenCalledTimes(1);
    expect(t.connect).toHaveBeenCalledWith(WINDOW_REF, 4);
    expect(t.connectByTarget).not.toHaveBeenCalled();
  });

  it('fetches the sessions itself once the server kind is known, and connects with the fetched ones', async () => {
    const t = setup({ servers, fetch: async () => sessions });
    t.queue.open(REQ);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.fetchSessions).toHaveBeenCalledWith('misaosrv');
    expect(t.connect).toHaveBeenCalledWith(WINDOW_REF, undefined);
  });

  it('falls back to server-side resolution when the sessions cannot be fetched', async () => {
    const t = setup({ servers, fetch: async () => { throw new Error('down'); } });
    t.queue.open(REQ, 2);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.connectByTarget).toHaveBeenCalledWith(REQ, 2);
    expect(t.connect).not.toHaveBeenCalled();
  });

  it('falls back to server-side resolution when loaded sessions do not list the window', () => {
    const t = setup({ servers, sessions: { misaosrv: sessions } });
    t.queue.open({ serverName: 'misaosrv', target: 'azito:gone' });
    expect(t.connectByTarget).toHaveBeenCalledTimes(1);
  });

  it('gives up at the real deadline, and a ready answer arriving later does not open it again', () => {
    const t = setup();
    t.queue.open(REQ);
    vi.advanceTimersByTime(PENDING_TERMINAL_OPEN_TTL_MS - 1);
    expect(t.connectByTarget).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(t.connectByTarget).toHaveBeenCalledTimes(1);
    t.state.servers = servers;
    t.state.sessions = { misaosrv: sessions };
    t.queue.notify();
    expect(t.connect).not.toHaveBeenCalled();
    expect(t.connectByTarget).toHaveBeenCalledTimes(1);
  });

  it('checks the deadline before readiness when the first notification comes after it', () => {
    const t = setup();
    t.queue.open(REQ);
    t.state.servers = servers;
    t.state.sessions = { misaosrv: sessions };
    vi.setSystemTime(Date.now() + PENDING_TERMINAL_OPEN_TTL_MS + 1);
    t.queue.notify();
    expect(t.connectByTarget).toHaveBeenCalledTimes(1);
    expect(t.connect).not.toHaveBeenCalled();
  });

  it('opens a tmux target at once and never waits', () => {
    const t = setup({ servers });
    t.queue.open({ serverName: 'tmuxsrv', target: 'azito:win' });
    expect(t.connect).toHaveBeenCalledTimes(1);
  });
});
