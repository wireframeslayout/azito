import { describe, expect, it, vi } from 'vitest';
import { asPaneHandle, type MuxRef, type PaneHandle, type PaneOrdinal } from '@azito/shared';
import type { ServerConfig } from '../../servers/Server';
import { MisaoMuxClient } from './MisaoMuxClient';
import { TmuxClient } from '../TmuxClient';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import { splitPaneEnv } from '../../../shared/auth/paneSecretEnv';
import type { MisaoAttachClient, MisaoEventSource, MisaoRpc } from './MisaoConnection';
import { MuxDriverUnavailableError, MuxOperationUnsupportedError } from '../MuxCapabilityError';
import { MuxDriverRegistry } from '../MuxDriverRegistry';
import { WindowInputService } from '../../transcripts/WindowInputService';
import type { IWindowRepository, Window } from '../../windows/Window';
import type { IServerRepository } from '../../servers/Server';

const server = { name: 'local', type: 'local', muxRuntime: 'misao' } as ServerConfig;
const HUB_ENV = { publicUrl: 'http://hub.example', localUrl: 'http://127.0.0.1:3001', webhookToken: 'wh-token' };
/** What every misao pane gets from hubPaneEnv on a non-isolated local server. */
const HUB_PANE_ENV = { AZITO_URL: 'http://127.0.0.1:3001', AZITO_WEBHOOK_TOKEN: 'wh-token' };

class FakeConnectionError extends Error {}

class FakeRpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

interface FakePane { paneId: string; windowId: string; workspace: string; cmd: string[]; cwd: string; env: Record<string, string>; labels: Record<string, string>; processState: 'running' | 'exited' | 'stopped'; pid: number | null; fgCommand?: string; title: string; lastOutputAt: string | null; screen: string }

/** An in-memory stand-in for the daemon's RPC surface, with a call log. */
class FakeDaemon implements MisaoRpc, MisaoEventSource {
  workspaces = new Map<string, Array<{ windowId: string; name: string }>>();
  panes: FakePane[] = [];
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  failures = new Map<string, Error>();
  reverseListOrder = false;
  private counter = 0;

  private id(prefix: 'p' | 'w'): string {
    this.counter += 1;
    return `${prefix}_0${String(this.counter).padStart(25, '0')}`;
  }

  addWindow(workspace: string, name: string): string {
    const windowId = this.id('w');
    this.workspaces.set(workspace, [...(this.workspaces.get(workspace) ?? []), { windowId, name }]);
    return windowId;
  }

  addPane(windowId: string, over: Partial<FakePane> = {}): FakePane {
    const [workspace] = [...this.workspaces].find(([, wins]) => wins.some((w) => w.windowId === windowId))!;
    const pane: FakePane = { paneId: this.id('p'), windowId, workspace, cmd: ['/bin/bash'], cwd: '/work', env: {}, labels: {}, processState: 'running', pid: 4242, title: '', lastOutputAt: null, screen: '', ...over };
    this.panes.push(pane);
    return pane;
  }

  private toInfo(p: FakePane) {
    const win = this.workspaces.get(p.workspace)!.find((w) => w.windowId === p.windowId)!;
    return { paneId: p.paneId, pid: p.pid, cmd: p.cmd, cwd: p.cwd, workspace: p.workspace, window: { id: win.windowId, name: win.name }, labels: p.labels, processState: p.processState, exitCode: null, signal: null, agentState: 'unknown', decidedBy: 'none', ...(p.fgCommand ? { fgCommand: p.fgCommand } : {}), title: p.title, lastOutputAt: p.lastOutputAt, cols: 80, rows: 24, clients: [], sizeOwner: null };
  }

  private findPane(paneId: unknown): FakePane {
    const pane = this.panes.find((p) => p.paneId === paneId);
    if (!pane) throw new FakeRpcError(1001, `pane not found: ${String(paneId)}`);
    return pane;
  }

  async request(method: string, params: Record<string, unknown>): Promise<never> {
    this.calls.push({ method, params });
    const failure = this.failures.get(method);
    if (failure) throw failure;
    return this.dispatch(method, params) as never;
  }

  private dispatch(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case 'workspace.list': return [...this.workspaces].map(([name, windows]) => ({ name, windows: windows.map((w) => ({ ...w, workspace: name })) }));
      case 'workspace.create':
        if (this.workspaces.has(params.name as string)) throw new FakeRpcError(1008, 'workspace already exists');
        this.workspaces.set(params.name as string, []);
        return { name: params.name, windows: [] };
      case 'workspace.close':
        this.workspaces.delete(params.name as string);
        this.panes = this.panes.filter((p) => p.workspace !== params.name);
        return { ok: true };
      case 'workspace.rename': {
        const wins = this.workspaces.get(params.name as string);
        if (!wins) throw new FakeRpcError(1006, 'workspace not found');
        this.workspaces.delete(params.name as string);
        this.workspaces.set(params.newName as string, wins);
        return { ok: true };
      }
      case 'window.create': {
        if (!this.workspaces.has(params.workspace as string)) throw new FakeRpcError(1006, 'workspace not found');
        return { windowId: this.addWindow(params.workspace as string, params.name as string), name: params.name, workspace: params.workspace };
      }
      case 'window.close': {
        for (const [ws, wins] of this.workspaces) {
          if (wins.some((w) => w.windowId === params.windowId)) this.workspaces.set(ws, wins.filter((w) => w.windowId !== params.windowId));
        }
        this.panes = this.panes.filter((p) => p.windowId !== params.windowId);
        return { ok: true };
      }
      case 'window.rename': {
        for (const wins of this.workspaces.values()) for (const w of wins) if (w.windowId === params.windowId) w.name = params.name as string;
        return { ok: true };
      }
      case 'pane.open': {
        const pane = this.addPane(params.windowId as string, { cmd: params.cmd as string[], cwd: (params.cwd as string | undefined) ?? '/work', env: (params.env as Record<string, string> | undefined) ?? {}, labels: (params.labels as Record<string, string> | undefined) ?? {} });
        return { paneId: pane.paneId };
      }
      case 'pane.list': {
        const infos = this.panes.map((p) => this.toInfo(p));
        return this.reverseListOrder ? infos.reverse() : infos;
      }
      case 'pane.info': return this.toInfo(this.findPane(params.paneId));
      case 'pane.screen': return { text: this.findPane(params.paneId).screen, cursor: { x: 0, y: 0 }, altScreen: false, title: '', activity: 7 };
      case 'pane.write': this.findPane(params.paneId); return { ok: true };
      case 'pane.close': {
        const closing = this.findPane(params.paneId);
        this.panes = this.panes.filter((p) => p !== closing);
        return { ok: true };
      }
      case 'pane.set_label': {
        const pane = this.findPane(params.paneId);
        pane.labels = { ...pane.labels, ...(params.set as Record<string, string>) };
        return { labels: pane.labels };
      }
      default: throw new FakeRpcError(1005, `not implemented: ${method}`);
    }
  }

  rpcErrorCode(err: unknown): number | undefined { return err instanceof FakeRpcError ? err.code : undefined; }
  isConnectionError(err: unknown): boolean { return err instanceof FakeConnectionError; }

  subscribeEvents = vi.fn(async () => ({ unsubscribe: () => {}, cursor: { seq: 0, epoch: 'e' } }));
  onGap = vi.fn(() => () => {});
  onConnected = vi.fn(() => () => {});
  onEventsRecovered = vi.fn(() => () => {});

  callsTo(method: string): Array<Record<string, unknown>> { return this.calls.filter((c) => c.method === method).map((c) => c.params); }
  writes(): string[] { return this.callsTo('pane.write').map((p) => p.data as string); }
}

function setup(over: { wait?: (ms: number) => Promise<void>; connectAttachClient?: () => Promise<MisaoAttachClient> } = {}) {
  const daemon = new FakeDaemon();
  const onChange = vi.fn();
  const wait = over.wait ?? vi.fn(async () => {});
  const client = new MisaoMuxClient(daemon, { shell: '/bin/zsh', onChange, log: { warn: vi.fn() }, hubEnv: HUB_ENV, connectAttachClient: over.connectAttachClient ?? vi.fn(async () => { throw new Error('connectAttachClient not expected'); }) }, wait);
  return { daemon, client, onChange, wait };
}

const refOf = (workspace: string, window: string): MuxRef => ({ kind: 'misao', workspace, window });
const handle = (p: { paneId: string }): PaneHandle => p.paneId as PaneHandle;

describe('MisaoMuxClient identity', () => {
  it('is a misao driver with caps matching what it implements', () => {
    const { client } = setup();
    expect(client.kind).toBe('misao');
    expect(client.caps).toEqual({ changeEvents: true, agentState: false, independentClients: true, copyMode: false });
    expect(client.supportsPaneLabels).toBe(true);
  });
});

describe('MisaoMuxClient reads', () => {
  it('maps workspaces to windows carrying a precomputed misao ref', async () => {
    const { daemon, client } = setup();
    const w1 = daemon.addWindow('proj', 'main');
    const w2 = daemon.addWindow('proj', 'second');
    daemon.addPane(w1, { fgCommand: 'claude', title: 'T', pid: 99, lastOutputAt: '2026-10-02T00:00:10.500Z' });
    daemon.addPane(w1, { processState: 'stopped', pid: null, cmd: ['/bin/bash', '-lc', 'x'] });
    const [ws] = await client.listWorkspaces(server);
    expect(ws).toMatchObject({ name: 'proj', windowCount: 2, attached: false });
    expect(ws.windows[0]).toMatchObject({ index: 1, name: 'main', ref: refOf('proj', w1), activity: Math.floor(Date.parse('2026-10-02T00:00:10.500Z') / 1000) });
    expect(ws.windows[0].panes).toEqual([
      { index: 1, handle: expect.stringMatching(/^p_/), command: 'claude', title: 'T', width: 80, height: 24, active: false, pid: 99, processState: 'running' },
      { index: 2, handle: expect.stringMatching(/^p_/), command: '/bin/bash', title: '', width: 80, height: 24, active: false, pid: 0, processState: 'stopped' },
    ]);
    expect(ws.windows[1]).toMatchObject({ index: 2, name: 'second', ref: refOf('proj', w2), panes: [], activity: 0 });
  });

  it('listWorkspacesStrict reads the same data and propagates daemon errors', async () => {
    const { daemon, client } = setup();
    daemon.addWindow('proj', 'main');
    expect((await client.listWorkspacesStrict(server)).map((w) => w.name)).toEqual(['proj']);
    daemon.failures.set('workspace.list', new MuxDriverUnavailableError('misao', 'daemon_unreachable'));
    await expect(client.listWorkspacesStrict(server)).rejects.toBeInstanceOf(MuxDriverUnavailableError);
  });

  it('numbers panes 1.. in creation order even if the daemon lists them differently', async () => {
    const { daemon, client } = setup();
    const w = daemon.addWindow('proj', 'main');
    const a = daemon.addPane(w);
    const b = daemon.addPane(w, { title: 'b' });
    const c = daemon.addPane(w);
    daemon.reverseListOrder = true;
    const ref = refOf('proj', w);
    expect((await client.listPanesByRef(server, ref)).map((p) => [p.ordinal, p.handle])).toEqual([[1, a.paneId], [2, b.paneId], [3, c.paneId]]);
    expect(await client.resolvePane(server, ref, 2)).toBe(b.paneId);
    await expect(client.resolvePane(server, ref, 4)).rejects.toThrow('out of range');
    await expect(client.resolvePane(server, ref, 0)).rejects.toThrow('out of range');
    await expect(client.resolvePane(server, ref, 1.5)).rejects.toThrow('out of range');
    expect(await client.refFromPaneHandle(server, handle(c))).toEqual({ ref, ordinal: 3 });
    expect(await client.refFromPaneHandle(server, 'p_0000000000000000000000000Z' as PaneHandle)).toBeNull();
  });

  it('throws for a window that does not exist instead of returning no panes', async () => {
    const { client } = setup();
    await expect(client.listPanesByRef(server, refOf('proj', 'w_0000000000000000000000000Z'))).rejects.toThrow('not found');
  });

  it('listAllPanes gives every pane a ref, window-relative 1-based indexes and the foreground command', async () => {
    const { daemon, client } = setup();
    const w1 = daemon.addWindow('proj', 'main');
    const w2 = daemon.addWindow('proj', 'other');
    daemon.addPane(w1, { fgCommand: 'claude', cwd: '/a' });
    const second = daemon.addPane(w2, { cwd: '/b' });
    const third = daemon.addPane(w2, { cwd: '/c' });
    const panes = await client.listAllPanes(server);
    expect(panes).toHaveLength(3);
    expect(panes[0]).toMatchObject({ sessionName: 'proj', windowIndex: 1, windowName: 'main', paneIndex: 1, currentPath: '/a', currentCommand: 'claude', ref: refOf('proj', w1) });
    expect(panes.find((p) => p.paneId === second.paneId)).toMatchObject({ windowIndex: 2, paneIndex: 1, ref: refOf('proj', w2) });
    expect(panes.find((p) => p.paneId === third.paneId)).toMatchObject({ windowIndex: 2, paneIndex: 2 });
  });

  it('windowExists / resolveRef', async () => {
    const { daemon, client } = setup();
    const w = daemon.addWindow('proj', 'main');
    daemon.addWindow('proj', 'dup');
    daemon.addWindow('proj', 'dup');
    expect(await client.windowExists(server, refOf('proj', w))).toBe(true);
    expect(await client.windowExists(server, refOf('proj', 'w_0000000000000000000000000Z'))).toBe(false);
    expect(await client.resolveRef(server, w)).toEqual(refOf('proj', w));
    expect(await client.resolveRef(server, 'proj:main')).toEqual(refOf('proj', w));
    expect(await client.resolveRef(server, `proj:${w}`)).toEqual(refOf('proj', w));
    expect(await client.resolveRef(server, `nope:${w}`)).toBeNull();
    expect(await client.resolveRef(server, 'proj:dup')).toBeNull();
    expect(await client.resolveRef(server, 'proj:none')).toBeNull();
    expect(await client.resolveRef(server, 'nope:main')).toBeNull();
    expect(await client.resolveRef(server, 'main')).toBeNull();
    expect(await client.resolveRef(server, 'w_0000000000000000000000000Z')).toBeNull();
  });

  it('probePane distinguishes alive, confirmed gone, exited and unverifiable', async () => {
    const { daemon, client } = setup();
    const w = daemon.addWindow('proj', 'main');
    const running = daemon.addPane(w);
    const exited = daemon.addPane(w, { processState: 'exited' });
    expect(await client.probePane(server, handle(running))).toEqual({ alive: true, verified: true });
    expect(await client.probePane(server, handle(exited))).toEqual({ alive: false, verified: true });
    expect(await client.probePane(server, 'p_0000000000000000000000000Z' as PaneHandle)).toEqual({ alive: false, verified: true });
    daemon.failures.set('pane.info', new MuxDriverUnavailableError('misao', 'daemon_unreachable'));
    expect(await client.probePane(server, handle(running))).toEqual({ alive: false, verified: false });
    daemon.failures.set('pane.info', new Error('boom'));
    expect(await client.probePane(server, handle(running))).toEqual({ alive: false, verified: false });
  });

  it('reads pid and foreground command from pane.info, null for a missing pane', async () => {
    const { daemon, client } = setup();
    const w = daemon.addWindow('proj', 'main');
    const p = daemon.addPane(w, { pid: 777, fgCommand: 'claude' });
    const stopped = daemon.addPane(w, { processState: 'stopped', pid: null });
    expect(await client.panePidByHandle(server, handle(p))).toBe(777);
    expect(await client.paneCommandByHandle(server, handle(p))).toBe('claude');
    expect(await client.panePidByHandle(server, handle(stopped))).toBeNull();
    expect(await client.paneCommandByHandle(server, handle(stopped))).toBeNull();
    const gone = 'p_0000000000000000000000000Z' as PaneHandle;
    expect(await client.panePidByHandle(server, gone)).toBeNull();
    expect(await client.paneCommandByHandle(server, gone)).toBeNull();
  });

  it('windowActivity is the latest output time in epoch seconds, or null when nothing was printed', async () => {
    const { daemon, client } = setup();
    const w = daemon.addWindow('proj', 'main');
    daemon.addPane(w);
    expect(await client.windowActivity(server, refOf('proj', w))).toBeNull();
    daemon.addPane(w, { lastOutputAt: '2026-10-02T00:00:10.900Z' });
    daemon.addPane(w, { lastOutputAt: '2026-10-02T00:00:05.000Z' });
    expect(await client.windowActivity(server, refOf('proj', w))).toBe(Math.floor(Date.parse('2026-10-02T00:00:10.900Z') / 1000));
  });

  it('measurePanePids lists running panes that have a pid', async () => {
    const { daemon, client } = setup();
    const w = daemon.addWindow('proj', 'main');
    daemon.addPane(w, { pid: 11 });
    daemon.addPane(w, { processState: 'exited', pid: 12 });
    daemon.addPane(w, { processState: 'stopped', pid: null });
    expect(await client.measurePanePids(server)).toEqual([{ ref: refOf('proj', w), pid: 11 }]);
  });

  it('captureScreen returns visible rows; negative starts clamp to the top', async () => {
    const { daemon, client } = setup();
    const w = daemon.addWindow('proj', 'main');
    const p = daemon.addPane(w, { screen: 'a\nb\nc\nd' });
    expect((await client.captureScreen(server, handle(p))).stdout).toBe('a\nb\nc\nd\n');
    expect((await client.captureScreen(server, handle(p), -200)).stdout).toBe('a\nb\nc\nd\n');
    expect((await client.captureScreen(server, handle(p), 1, 2)).stdout).toBe('b\nc\n');
    expect((await client.captureScreen(server, handle(p), 5)).stdout).toBe('');
    expect(await client.captureScreen(server, handle(p))).toMatchObject({ stderr: '', code: 0 });
  });
});

describe('MisaoMuxClient writes', () => {
  it('openWorkspace creates workspace, window and a hub-labelled shell pane in order', async () => {
    const { daemon, client } = setup();
    const { ref, result } = await client.openWorkspace(server, 'proj', { windowName: 'main', exactName: true, extraEnv: { FOO: 'bar' } });
    expect(daemon.calls.map((c) => c.method)).toEqual(['workspace.create', 'window.create', 'pane.open']);
    expect(ref).toEqual(refOf('proj', daemon.workspaces.get('proj')![0].windowId));
    expect(result).toEqual({ stdout: '', stderr: '', code: 0 });
    expect(daemon.callsTo('window.create')[0]).toEqual({ workspace: 'proj', name: 'main' });
    expect(daemon.callsTo('pane.open')[0]).toEqual({ cmd: ['/bin/zsh'], windowId: ref.window, labels: { origin: 'hub', name: 'main' }, ephemeralEnv: { ...HUB_PANE_ENV, FOO: 'bar' } });
    expect(daemon.callsTo('pane.open')[0]).not.toHaveProperty('env');
    expect(daemon.panes[0].env).toEqual({});
  });

  it('openWorkspace runs a command through a login shell and generates a window name unless exact', async () => {
    const { daemon, client } = setup();
    await client.openWorkspace(server, 'proj', { command: 'claude --resume', windowName: 'task' });
    expect(daemon.callsTo('pane.open')[0].cmd).toEqual(['/bin/zsh', '-lc', 'claude --resume']);
    expect(daemon.callsTo('window.create')[0].name).toMatch(/^task--[a-z0-9]{4}$/);
    expect(daemon.callsTo('pane.open')[0]).not.toHaveProperty('env');
  });

  it('openWorkspace removes the workspace it created when a later step fails', async () => {
    const { daemon, client } = setup();
    daemon.failures.set('pane.open', new FakeRpcError(-32602, 'cannot spawn'));
    await expect(client.openWorkspace(server, 'proj')).rejects.toThrow('cannot spawn');
    expect(daemon.workspaces.has('proj')).toBe(false);
    expect(daemon.calls.map((c) => c.method)).toEqual(['workspace.create', 'window.create', 'pane.open', 'window.close', 'workspace.close']);
  });

  it('openWorkspace leaves an existing workspace alone when the name is taken', async () => {
    const { daemon, client } = setup();
    daemon.addWindow('proj', 'keep');
    await expect(client.openWorkspace(server, 'proj')).rejects.toThrow('already exists');
    expect(daemon.workspaces.get('proj')).toHaveLength(1);
    expect(daemon.callsTo('workspace.close')).toEqual([]);
  });

  it('openPaneInWindow opens a hub-labelled shell pane in the window and types the command into it', async () => {
    const { daemon, client } = setup();
    const w = daemon.addWindow('proj', 'main');
    const opened = await client.openPaneInWindow(server, refOf('proj', w), { command: 'claude', extraEnv: { FOO: 'bar' } });
    expect(daemon.callsTo('pane.open')).toEqual([{ cmd: ['/bin/zsh'], windowId: w, labels: { origin: 'hub', name: 'main' }, ephemeralEnv: { ...HUB_PANE_ENV, FOO: 'bar' } }]);
    expect(opened).toBe(daemon.panes[0].paneId);
    expect(daemon.callsTo('pane.write')).toEqual([{ paneId: opened, data: 'claude', source: 'hub' }, { paneId: opened, data: '\r', source: 'hub' }]);
  });

  it("openPaneInWindow labels the pane with a registered window's windowId and task", async () => {
    const { daemon, client } = setup();
    const w = daemon.addWindow('proj', 'main');
    await client.openPaneInWindow(server, refOf('proj', w), { labels: { windowId: 5, taskId: 42 } });
    expect(daemon.callsTo('pane.open')[0]).toMatchObject({ labels: { origin: 'hub', name: 'main', windowId: '5', task: '42' } });
  });

  it('openPaneInWindow without a command only opens the shell', async () => {
    const { daemon, client } = setup();
    const w = daemon.addWindow('proj', 'main');
    await client.openPaneInWindow(server, refOf('proj', w));
    expect(daemon.callsTo('pane.write')).toEqual([]);
  });

  it('openPaneInWindow fails before pane.open when the window does not exist', async () => {
    const { daemon, client } = setup();
    await expect(client.openPaneInWindow(server, refOf('proj', 'w_missing'))).rejects.toThrow('not found');
    expect(daemon.callsTo('pane.open')).toEqual([]);
  });

  it('openWindow adds a window with a pane to an existing workspace', async () => {
    const { daemon, client } = setup();
    daemon.workspaces.set('proj', []);
    const { ref, windowName } = await client.openWindow(server, 'proj', 'win', { extraEnv: { K: 'v' } });
    expect(windowName).toMatch(/^win--[a-z0-9]{4}$/);
    expect(ref.workspace).toBe('proj');
    expect(daemon.callsTo('pane.open')[0]).toMatchObject({ labels: { origin: 'hub', name: windowName }, ephemeralEnv: { ...HUB_PANE_ENV, K: 'v' } });
    expect(daemon.callsTo('pane.open')[0]).not.toHaveProperty('env');
    const exact = await client.openWindow(server, 'proj', 'fixed', { exactName: true });
    expect(exact.windowName).toBe('fixed');
  });

  it('openWindow closes the window it created when the pane cannot start, and fails on a missing workspace', async () => {
    const { daemon, client } = setup();
    daemon.workspaces.set('proj', []);
    daemon.failures.set('pane.open', new FakeRpcError(-32602, 'cannot spawn'));
    await expect(client.openWindow(server, 'proj')).rejects.toThrow('cannot spawn');
    expect(daemon.workspaces.get('proj')).toEqual([]);
    await expect(client.openWindow(server, 'missing')).rejects.toThrow('workspace not found');
  });

  it('flags a NotFound close as alreadyGone only when the daemon confirms the target is absent', async () => {
    const { daemon, client } = setup();
    const w = daemon.addWindow('proj', 'main');
    daemon.failures.set('window.close', new FakeRpcError(1007, 'window not found: w_x'));
    // Still listed (e.g. mid-close): not gone.
    const live = await client.closeWindow(server, refOf('proj', w));
    expect(live.code).toBe(1);
    expect(live.alreadyGone).toBeUndefined();
    // Absent from workspace.list: gone.
    expect(await client.closeWindow(server, refOf('proj', 'w_missing'))).toMatchObject({ code: 1, alreadyGone: true });

    daemon.failures.set('workspace.close', new FakeRpcError(1006, 'workspace not found'));
    expect((await client.closeWorkspace(server, 'proj')).alreadyGone).toBeUndefined();
    expect(await client.closeWorkspace(server, 'nope')).toMatchObject({ code: 1, alreadyGone: true });

    daemon.failures.set('pane.close', new FakeRpcError(1001, 'pane not found'));
    expect(await client.closePane(server, asPaneHandle('p_missing'))).toMatchObject({ code: 1, alreadyGone: true });
  });

  it('never flags a close that failed with another code, e.g. a child PaneNotFound aborting window/workspace close', async () => {
    const { daemon, client } = setup();
    const w = daemon.addWindow('proj', 'main');
    daemon.failures.set('window.close', new FakeRpcError(1001, 'pane not found'));
    expect((await client.closeWindow(server, refOf('proj', 'w_missing'))).alreadyGone).toBeUndefined();
    daemon.failures.set('workspace.close', new FakeRpcError(1001, 'pane not found'));
    expect((await client.closeWorkspace(server, 'nope')).alreadyGone).toBeUndefined();
    daemon.failures.set('pane.close', new FakeRpcError(1007, 'window not found'));
    expect((await client.closePane(server, asPaneHandle('p_missing'))).alreadyGone).toBeUndefined();
    expect(w).toBeTruthy();
  });

  it('does not flag alreadyGone for a rename NotFound', async () => {
    const { client } = setup();
    expect((await client.renameWorkspace(server, 'nope', 'x')).alreadyGone).toBeUndefined();
  });

  it('close and rename report RPC errors as a failed ExecResult and rethrow connection errors', async () => {
    const { daemon, client } = setup();
    const w = daemon.addWindow('proj', 'main');
    expect(await client.renameWindowByRef(server, refOf('proj', w), 'renamed')).toMatchObject({ code: 0 });
    expect(daemon.workspaces.get('proj')![0].name).toBe('renamed');
    expect(await client.renameWorkspace(server, 'proj', 'proj2')).toMatchObject({ code: 0 });
    expect(await client.renameWorkspace(server, 'nope', 'x')).toMatchObject({ code: 1, stderr: 'workspace not found' });
    expect(await client.closeWindow(server, refOf('proj2', w))).toMatchObject({ code: 0 });
    expect(await client.closeWorkspace(server, 'proj2')).toMatchObject({ code: 0 });
    daemon.failures.set('workspace.close', new MuxDriverUnavailableError('misao', 'daemon_unreachable'));
    await expect(client.closeWorkspace(server, 'proj2')).rejects.toBeInstanceOf(MuxDriverUnavailableError);
  });

  it('closePane reports a missing pane as code 1', async () => {
    const { daemon, client } = setup();
    const w = daemon.addWindow('proj', 'main');
    const p = daemon.addPane(w);
    expect(await client.closePane(server, handle(p))).toMatchObject({ code: 0 });
    expect(await client.closePane(server, handle(p))).toMatchObject({ code: 1 });
  });

  it('splitPaneByHandle opens a pane in the same window, inheriting cwd and the hub identity labels', async () => {
    const { daemon, client } = setup();
    const w = daemon.addWindow('proj', 'main');
    const source = daemon.addPane(w, { cwd: '/repo', labels: { origin: 'hub', name: 'old', windowId: '806', task: '12', other: 'x' } });
    const res = await client.splitPaneByHandle(server, handle(source), 'h', { AZITO_TASK_ID: '12', AZITO_TASK_TOKEN: 't', AZITO_UI_TOKEN: '' });
    expect(daemon.callsTo('pane.open')[0]).toEqual({
      cmd: ['/bin/zsh'], cwd: '/repo', windowId: w,
      labels: { origin: 'hub', name: 'main', windowId: '806', task: '12' },
      env: { AZITO_TASK_ID: '12' },
      ephemeralEnv: { ...HUB_PANE_ENV, AZITO_TASK_TOKEN: 't', AZITO_UI_TOKEN: '' },
    });
    expect(res.handle).toBe(daemon.panes[1].paneId);
    expect((await client.listPanesByRef(server, refOf('proj', w))).map((p) => p.ordinal)).toEqual([1, 2]);
  });

  it('labelWindowPanes stamps every pane of the window and only that window', async () => {
    const { daemon, client } = setup();
    const w1 = daemon.addWindow('proj', 'a');
    const w2 = daemon.addWindow('proj', 'b');
    const a1 = daemon.addPane(w1);
    const a2 = daemon.addPane(w1);
    const b1 = daemon.addPane(w2);
    await client.labelWindowPanes(server, refOf('proj', w1), { windowId: 806, taskId: 448 });
    expect(a1.labels).toEqual({ windowId: '806', task: '448' });
    expect(a2.labels).toEqual({ windowId: '806', task: '448' });
    expect(b1.labels).toEqual({});
    await client.labelWindowPanes(server, refOf('proj', w2), { windowId: 807 });
    expect(b1.labels).toEqual({ windowId: '807' });
  });
});

describe('MisaoMuxClient pane env (hub env a misao pane does not inherit)', () => {
  const isolated = { name: 'local', type: 'local', muxRuntime: 'misao', isolationIntent: true } as ServerConfig;

  it('gives every pane-creating call AZITO_URL and the webhook token as ephemeralEnv, never as persisted env', async () => {
    const { daemon, client } = setup();
    const w = daemon.addWindow('proj', 'main');
    const source = daemon.addPane(w, {});
    await client.openWorkspace(server, 'ws', { windowName: 'a', exactName: true });
    await client.openWindow(server, 'proj', 'b');
    await client.openPaneInWindow(server, refOf('proj', w));
    await client.splitPaneByHandle(server, handle(source), 'v');
    const opens = daemon.callsTo('pane.open');
    expect(opens).toHaveLength(4);
    for (const open of opens) {
      expect(open.ephemeralEnv).toEqual(HUB_PANE_ENV);
      expect(open).not.toHaveProperty('env');
    }
  });

  it('keeps the hub secret out of every persisted field of the pane.open call', async () => {
    const { daemon, client } = setup();
    await client.openWorkspace(server, 'ws', { extraEnv: { AZITO_TASK_ID: '3', AZITO_TASK_TOKEN: 'task-secret' } });
    const { ephemeralEnv, ...persisted } = daemon.callsTo('pane.open')[0];
    expect(JSON.stringify(persisted)).not.toContain('wh-token');
    expect(JSON.stringify(persisted)).not.toContain('task-secret');
    expect(persisted.env).toEqual({ AZITO_TASK_ID: '3' });
    expect(ephemeralEnv).toEqual({ ...HUB_PANE_ENV, AZITO_TASK_TOKEN: 'task-secret' });
  });

  it('lets the caller env override the hub env', async () => {
    const { daemon, client } = setup();
    await client.openWorkspace(server, 'ws', { extraEnv: { AZITO_WEBHOOK_TOKEN: 'override' } });
    expect(daemon.callsTo('pane.open')[0].ephemeralEnv).toEqual({ AZITO_URL: HUB_PANE_ENV.AZITO_URL, AZITO_WEBHOOK_TOKEN: 'override' });
  });

  it('does not hand the webhook token to an isolated server, and keeps the mask env the caller passes', async () => {
    const { daemon, client } = setup();
    await client.openWorkspace(isolated, 'ws', { extraEnv: { AZITO_UI_TOKEN: '', AZITO_AGENT_TOKEN: '' } });
    expect(daemon.callsTo('pane.open')[0].ephemeralEnv).toEqual({ AZITO_URL: HUB_PANE_ENV.AZITO_URL, AZITO_UI_TOKEN: '', AZITO_AGENT_TOKEN: '', AZITO_WEBHOOK_TOKEN: '' });
  });

  it('keeps the hub webhook token on a non-isolated server when the caller passes the scoped-auth mask (UI and agent token only)', async () => {
    const { daemon, client } = setup();
    await client.openWorkspace(server, 'ws', { extraEnv: { AZITO_UI_TOKEN: '', AZITO_AGENT_TOKEN: '' } });
    expect(daemon.callsTo('pane.open')[0].ephemeralEnv).toEqual({ ...HUB_PANE_ENV, AZITO_UI_TOKEN: '', AZITO_AGENT_TOKEN: '' });
  });

  it('blanks every hub credential on an isolated server even when no mask or a real token is passed', async () => {
    const { daemon, client } = setup();
    const w = daemon.addWindow('proj', 'main');
    const source = daemon.addPane(w, {});
    const leak = { AZITO_UI_TOKEN: 'ui', AZITO_AGENT_TOKEN: 'agent', AZITO_WEBHOOK_TOKEN: 'wh' };
    const blank = { AZITO_URL: HUB_PANE_ENV.AZITO_URL, AZITO_UI_TOKEN: '', AZITO_AGENT_TOKEN: '', AZITO_WEBHOOK_TOKEN: '' };
    await client.openWorkspace(isolated, 'ws', { extraEnv: leak });
    await client.openWindow(isolated, 'proj', 'x', { extraEnv: leak });
    await client.openPaneInWindow(isolated, refOf('proj', w));
    await client.splitPaneByHandle(isolated, handle(source), 'h', leak);
    for (const open of daemon.callsTo('pane.open')) expect(open.ephemeralEnv).toEqual(blank);
  });

  // The rule must be identical to TmuxClient's: capture the `-e` args tmux is given for the same server and
  // compare them to what misao puts in the pane's env, for isolated and non-isolated servers.
  it.each([
    ['non-isolated local', { name: 'local', type: 'local', muxRuntime: 'misao' }],
    ['isolated local', { name: 'local', type: 'local', muxRuntime: 'misao', isolationIntent: true }],
  ])('passes the same env as TmuxClient for a %s server', async (_label, cfg) => {
    const srv = cfg as ServerConfig;
    const extraEnv = { AZITO_UI_TOKEN: srv.isolationIntent ? '' : 'ui-secret' };
    const tmuxArgs: string[][] = [];
    const factory = { getTransport: () => ({ execMux: async (req: { args: string[] }) => { tmuxArgs.push(req.args); return { stdout: '', stderr: '', code: 0 }; } }) } as unknown as TransportFactory;
    await new TmuxClient(factory, HUB_ENV.publicUrl, 'ui-secret', HUB_ENV.localUrl, HUB_ENV.webhookToken).createWindow(srv, 'sess', 'win', { extraEnv });
    const tmuxEnv: Record<string, string> = {};
    const newWindow = tmuxArgs.find((a) => a[0] === 'new-window')!;
    newWindow.forEach((arg, i) => { if (arg === '-e') { const [k, ...v] = newWindow[i + 1].split('='); tmuxEnv[k] = v.join('='); } });

    const { daemon, client } = setup();
    daemon.workspaces.set('proj', []);
    await client.openWindow(srv, 'proj', 'win', { extraEnv });
    const { env, ephemeralEnv } = daemon.callsTo('pane.open')[0] as { env?: Record<string, string>; ephemeralEnv?: Record<string, string> };
    expect({ ...env, ...ephemeralEnv }).toEqual(tmuxEnv);
    expect(splitPaneEnv(tmuxEnv).env).toEqual(env ?? {});
  });
});

describe('MisaoMuxClient input', () => {
  it('writes special keys as bytes and everything else literally, with source hub, never via send_keys', async () => {
    const { daemon, client } = setup();
    const w = daemon.addWindow('proj', 'main');
    const p = daemon.addPane(w);
    await client.sendKeysToHandle(server, handle(p), ['1', 'Enter', 'C-c', 'Up', 'hello world']);
    expect(daemon.writes()).toEqual(['1', '\r', '\x03', '\x1b[A', 'hello world']);
    expect(daemon.callsTo('pane.write').every((c) => c.source === 'hub' && c.paneId === p.paneId)).toBe(true);
    expect(daemon.callsTo('pane.send_keys')).toEqual([]);
  });

  it('waits before Enter that follows a long literal, as the tmux driver does', async () => {
    const wait = vi.fn(async () => {});
    const { daemon, client } = setup({ wait });
    const w = daemon.addWindow('proj', 'main');
    const p = daemon.addPane(w);
    await client.sendKeysToHandle(server, handle(p), ['x'.repeat(501), 'Enter']);
    expect(wait).toHaveBeenCalledWith(2000);
    expect(daemon.writes()).toEqual(['x'.repeat(501), '\r']);
    wait.mockClear();
    await client.sendKeysToHandle(server, handle(p), ['x'.repeat(500), 'Enter']);
    await client.sendKeysToHandle(server, handle(p), ['x'.repeat(501)]);
    expect(wait).not.toHaveBeenCalled();
  });

  it('sendTextToHandle writes the text untouched, even when it looks like a key name', async () => {
    const { daemon, client } = setup();
    const w = daemon.addWindow('proj', 'main');
    const p = daemon.addPane(w);
    await client.sendTextToHandle(server, handle(p), 'Enter');
    await client.sendTextToHandle(server, handle(p), 'line1\nline2');
    expect(daemon.writes()).toEqual(['Enter', 'line1\nline2']);
  });

  it('waits after a long text before returning, so a following Enter is not folded into the paste', async () => {
    const wait = vi.fn(async () => {});
    const { daemon, client } = setup({ wait });
    const w = daemon.addWindow('proj', 'main');
    const p = daemon.addPane(w);
    await client.sendTextToHandle(server, handle(p), 'x'.repeat(501));
    expect(daemon.writes()).toEqual(['x'.repeat(501)]);
    expect(wait).toHaveBeenCalledWith(3000);
    wait.mockClear();
    await client.sendTextToHandle(server, handle(p), 'x'.repeat(500));
    expect(wait).not.toHaveBeenCalled();
  });

  it('surfaces a missing pane as an RPC error', async () => {
    const { client } = setup();
    await expect(client.sendTextToHandle(server, 'p_0000000000000000000000000Z' as PaneHandle, 'x')).rejects.toThrow('pane not found');
  });
});

describe('MisaoMuxClient unsupported operations', () => {
  it.each([
    ['focusWindow', (c: MisaoMuxClient, h: PaneHandle) => c.focusWindow(server, refOf('p', 'w'))],
    ['startOutputStream', (c: MisaoMuxClient, h: PaneHandle) => c.startOutputStream(server, h, '/tmp/x')],
    ['stopOutputStream', (c: MisaoMuxClient, h: PaneHandle) => c.stopOutputStream(server, h)],
    ['zoomPaneByHandle', (c: MisaoMuxClient, h: PaneHandle) => c.zoomPaneByHandle(server, h)],
    ['unzoomPaneByHandle', (c: MisaoMuxClient, h: PaneHandle) => c.unzoomPaneByHandle(server, h)],
    ['isPaneInModeByHandle', (c: MisaoMuxClient, h: PaneHandle) => c.isPaneInModeByHandle(server, h)],
    ['cancelPaneModeByHandle', (c: MisaoMuxClient, h: PaneHandle) => c.cancelPaneModeByHandle(server, h)],
    ['setPaneTitle', (c: MisaoMuxClient, h: PaneHandle) => c.setPaneTitle(server, h, 't')],
    ['captureLayout', (c: MisaoMuxClient, h: PaneHandle) => c.captureLayout(server, refOf('p', 'w'))],
    ['applyLayout', (c: MisaoMuxClient, h: PaneHandle) => c.applyLayout(server, refOf('p', 'w'), 'l')],
  ])('%s throws MuxOperationUnsupportedError without calling the daemon', async (operation, call) => {
    const { daemon, client } = setup();
    const err = await call(client, 'p_0000000000000000000000000Z' as PaneHandle).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MuxOperationUnsupportedError);
    expect(err).toMatchObject({ kind: 'misao', operation });
    expect(daemon.calls).toEqual([]);
  });
});

describe('MisaoMuxClient change hooks', () => {
  it('installChangeHooks subscribes to daemon events once for any number of servers', async () => {
    const { daemon, client } = setup();
    await client.installChangeHooks(server);
    await client.installChangeHooks({ ...server, name: 'other' } as ServerConfig);
    expect(daemon.subscribeEvents).toHaveBeenCalledTimes(1);
  });
});

describe('MisaoMuxClient behind WindowInputService', () => {
  it('sends input to a pane of the registered window without ever asking about copy mode', async () => {
    const { daemon, client } = setup();
    const w = daemon.addWindow('proj', 'main');
    const other = daemon.addWindow('proj', 'other');
    const pane = daemon.addPane(w);
    const otherPane = daemon.addPane(other);
    const isPaneInMode = vi.spyOn(client, 'isPaneInModeByHandle');
    const registry = new MuxDriverRegistry({ misaoEnabled: true });
    registry.register('misao', client);
    const window = { id: 5, serverName: 'local', tmuxTarget: '', muxRef: refOf('proj', w), workerType: null } as unknown as Window;
    const service = new WindowInputService(
      { findById: () => window } as unknown as IWindowRepository,
      registry,
      { findByName: () => server } as unknown as IServerRepository,
      async () => {},
    );

    expect(await service.sendInput(5, handle(pane), 'hello')).toBe('ok');
    expect(daemon.writes()).toEqual(['hello', '\r']);
    expect(await service.sendInput(5, handle(otherPane), 'nope')).toBe('pane_not_found');
    expect(await service.resolvePaneIndex(5, pane.paneId)).toBe(1);
    expect(await service.resolvePaneIndex(5, otherPane.paneId)).toBe('pane_not_found');
    expect(isPaneInMode).not.toHaveBeenCalled();
  });
});

describe('MisaoMuxClient openTerminal', () => {
  function fakeAttachClient(request: (method: string, params: Record<string, unknown>) => Promise<unknown> = async () => ({ head: 0, oldest: 0, truncated: false })) {
    return {
      request: vi.fn(request),
      subscribeEvents: vi.fn(async () => ({ unsubscribe: () => {}, cursor: { seq: 0, epoch: 'e' } })),
      onNotification: vi.fn(() => () => {}),
      onStateChange: vi.fn(() => () => {}),
      close: vi.fn(),
    };
  }

  it('attaches the ordinal-th pane of the window with a client id of its own', async () => {
    const attach = fakeAttachClient();
    const { daemon, client } = setup({ connectAttachClient: async () => attach as unknown as MisaoAttachClient });
    const w = daemon.addWindow('proj', 'main');
    daemon.addPane(w);
    const second = daemon.addPane(w);

    await client.openTerminal(server, refOf('proj', w), 2 as PaneOrdinal, 100, 30);

    expect(attach.request).toHaveBeenCalledWith('pane.attach', expect.objectContaining({ paneId: second.paneId, mode: 'raw', replay: 'snapshot', cols: 100, rows: 30, clientId: expect.stringMatching(/^azito-term-/) }));
  });

  it('gives every terminal a distinct client id', async () => {
    const attaches = [fakeAttachClient(), fakeAttachClient()];
    const { daemon, client } = setup({ connectAttachClient: async () => attaches.shift() as unknown as MisaoAttachClient });
    const w = daemon.addWindow('proj', 'main');
    daemon.addPane(w);
    const first = attaches[0];
    const second = attaches[1];
    await client.openTerminal(server, refOf('proj', w), 1 as PaneOrdinal, 80, 24);
    await client.openTerminal(server, refOf('proj', w), 1 as PaneOrdinal, 80, 24);
    const idOf = (a: typeof first) => (a.request.mock.calls[0][1] as { clientId: string }).clientId;
    expect(idOf(first)).not.toBe(idOf(second));
  });

  it('throws WINDOW_NOT_FOUND for a missing window without opening a connection', async () => {
    const connectAttachClient = vi.fn();
    const { client } = setup({ connectAttachClient });
    await expect(client.openTerminal(server, refOf('proj', 'w_missing'), 1 as PaneOrdinal, 80, 24)).rejects.toThrow('WINDOW_NOT_FOUND');
    expect(connectAttachClient).not.toHaveBeenCalled();
  });

  it('rejects an ordinal out of range without opening a connection', async () => {
    const connectAttachClient = vi.fn();
    const { daemon, client } = setup({ connectAttachClient });
    const w = daemon.addWindow('proj', 'main');
    daemon.addPane(w);
    await expect(client.openTerminal(server, refOf('proj', w), 2 as PaneOrdinal, 80, 24)).rejects.toThrow('out of range (1..1)');
    expect(connectAttachClient).not.toHaveBeenCalled();
  });

  it.each([1.5, Number.NaN])('rejects a non-integer ordinal (%s) without opening a connection', async (ordinal) => {
    const connectAttachClient = vi.fn();
    const { daemon, client } = setup({ connectAttachClient });
    const w = daemon.addWindow('proj', 'main');
    daemon.addPane(w);
    daemon.addPane(w);
    await expect(client.openTerminal(server, refOf('proj', w), ordinal as PaneOrdinal, 80, 24)).rejects.toThrow('out of range (1..2)');
    expect(connectAttachClient).not.toHaveBeenCalled();
  });

  it('reports a connection lost during the attach as an unreachable daemon, closing the connection', async () => {
    const attach = fakeAttachClient(async () => { throw new FakeConnectionError('connection closed'); });
    const { daemon, client } = setup({ connectAttachClient: async () => attach as unknown as MisaoAttachClient });
    const w = daemon.addWindow('proj', 'main');
    daemon.addPane(w);
    await expect(client.openTerminal(server, refOf('proj', w), 1 as PaneOrdinal, 80, 24)).rejects.toMatchObject({ name: 'MuxDriverUnavailableError', reason: 'daemon_unreachable' });
    expect(attach.close).toHaveBeenCalled();
  });

  it('closes the connection when the attach fails, mapping pane-not-found to WINDOW_NOT_FOUND', async () => {
    const attach = fakeAttachClient(async () => { throw new FakeRpcError(1001, 'pane not found'); });
    const { daemon, client } = setup({ connectAttachClient: async () => attach as unknown as MisaoAttachClient });
    const w = daemon.addWindow('proj', 'main');
    daemon.addPane(w);
    await expect(client.openTerminal(server, refOf('proj', w), 1 as PaneOrdinal, 80, 24)).rejects.toThrow('WINDOW_NOT_FOUND');
    expect(attach.close).toHaveBeenCalled();
  });

  it('maps an attach the daemon refuses with pane-exited to PANE_STOPPED so the browser stops reconnecting', async () => {
    const attach = fakeAttachClient(async () => { throw new FakeRpcError(1002, 'pane is stopped'); });
    const { daemon, client } = setup({ connectAttachClient: async () => attach as unknown as MisaoAttachClient });
    const w = daemon.addWindow('proj', 'main');
    daemon.addPane(w);
    await expect(client.openTerminal(server, refOf('proj', w), 1 as PaneOrdinal, 80, 24)).rejects.toThrow('PANE_STOPPED');
    expect(attach.close).toHaveBeenCalled();
  });

  it('throws PANE_STOPPED for a stopped pane without opening a connection', async () => {
    const connectAttachClient = vi.fn();
    const { daemon, client } = setup({ connectAttachClient });
    const w = daemon.addWindow('proj', 'main');
    daemon.addPane(w, { processState: 'stopped', pid: null });
    await expect(client.openTerminal(server, refOf('proj', w), 1 as PaneOrdinal, 80, 24)).rejects.toThrow('PANE_STOPPED');
    expect(connectAttachClient).not.toHaveBeenCalled();
  });

  it('attaches an exited pane as before (the daemon still holds its screen)', async () => {
    const attach = fakeAttachClient();
    const connectAttachClient = vi.fn(async () => attach as unknown as MisaoAttachClient);
    const { daemon, client } = setup({ connectAttachClient });
    const w = daemon.addWindow('proj', 'main');
    daemon.addPane(w, { processState: 'exited', pid: null });
    await client.openTerminal(server, refOf('proj', w), 1 as PaneOrdinal, 80, 24);
    expect(connectAttachClient).toHaveBeenCalled();
  });

  it('throws WINDOW_EMPTY for a window without panes, without opening a connection', async () => {
    const connectAttachClient = vi.fn();
    const { daemon, client } = setup({ connectAttachClient });
    const w = daemon.addWindow('proj', 'main');
    await expect(client.openTerminal(server, refOf('proj', w), 1 as PaneOrdinal, 80, 24)).rejects.toThrow('WINDOW_EMPTY');
    expect(connectAttachClient).not.toHaveBeenCalled();
  });

  it('closes the connection and rethrows other attach failures unchanged', async () => {
    const failure = new FakeRpcError(1004, 'unsupported');
    const attach = fakeAttachClient(async () => { throw failure; });
    const { daemon, client } = setup({ connectAttachClient: async () => attach as unknown as MisaoAttachClient });
    const w = daemon.addWindow('proj', 'main');
    daemon.addPane(w);
    await expect(client.openTerminal(server, refOf('proj', w), 1 as PaneOrdinal, 80, 24)).rejects.toBe(failure);
    expect(attach.close).toHaveBeenCalled();
  });
});
