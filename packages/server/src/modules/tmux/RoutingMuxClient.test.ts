import { describe, it, expect, vi } from 'vitest';
import { asPaneHandle, type MuxDriverKind, type MuxRef, type MuxWorkspace } from '@azito/shared';
import type { ServerConfig } from '../servers/Server';
import type { IMuxClient } from './IMuxClient';
import { MuxDriverRegistry } from './MuxDriverRegistry';
import { MuxDriverUnavailableError } from './MuxCapabilityError';
import { RoutingMuxClient } from './RoutingMuxClient';

const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const MISAO_PANE = asPaneHandle(`p_${ULID}`);
const TMUX_PANE = asPaneHandle('%12');
const misaoRef: MuxRef = { kind: 'misao', workspace: 'ws', window: `w_${ULID}` };
const tmuxRef: MuxRef = { kind: 'tmux', workspace: 'ws', window: 'win' };

const server = { name: 'srv', type: 'local', defaultMux: 'tmux' } as ServerConfig;

type FakeDriver = IMuxClient & Record<string, ReturnType<typeof vi.fn>>;

/** A driver whose every method is a spy; `overrides` set the ones a test cares about. */
function fakeDriver(kind: MuxDriverKind, overrides: Record<string, unknown> = {}): FakeDriver {
  const methods = new Map<string, ReturnType<typeof vi.fn>>();
  return new Proxy({ kind, caps: { copyMode: kind === 'tmux' }, supportsPaneLabels: kind === 'misao', ...overrides } as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (!methods.has(prop)) methods.set(prop, vi.fn(async () => undefined));
      return methods.get(prop);
    },
  }) as unknown as FakeDriver;
}

function workspace(name: string): MuxWorkspace {
  return { name, windowCount: 0, attached: false, created: 0, windows: [] };
}

function setup(opts: { tmux?: FakeDriver; misao?: FakeDriver; misaoAvailable?: boolean; defaultMux?: MuxDriverKind } = {}) {
  const tmux = opts.tmux ?? fakeDriver('tmux');
  const misao = opts.misao ?? fakeDriver('misao');
  const registry = new MuxDriverRegistry();
  registry.register('tmux', tmux);
  // An agent server here is one that has no misao (the hub's driver lists misao on an agent only once it was set up).
  registry.register('misao', misao, (s) => {
    if (s.type !== undefined && s.type !== 'local') return { available: false, reason: 'not_installed' };
    return opts.misaoAvailable === false ? { available: false, reason: 'daemon_unreachable' } : { available: true };
  }, (s) => s.type !== 'agent');
  const srv = { ...server, defaultMux: opts.defaultMux ?? 'tmux' } as ServerConfig;
  return { tmux, misao, registry, routing: registry.resolve(srv), srv };
}

describe('RoutingMuxClient delegation', () => {
  it('sends a ref-based call to the driver of ref.kind', async () => {
    const { tmux, misao, routing, srv } = setup();
    await routing.closeWindow(srv, misaoRef);
    await routing.windowExists(srv, tmuxRef);
    expect(misao.closeWindow).toHaveBeenCalledWith(srv, misaoRef);
    expect(tmux.closeWindow).not.toHaveBeenCalled();
    expect(tmux.windowExists).toHaveBeenCalledWith(srv, tmuxRef);
    expect(misao.windowExists).not.toHaveBeenCalled();
  });

  it('sends a handle-based call by the shape of the handle', async () => {
    const { tmux, misao, routing, srv } = setup();
    await routing.captureScreen(srv, MISAO_PANE, 0, 10);
    await routing.sendTextToHandle(srv, TMUX_PANE, 'hi');
    expect(misao.captureScreen).toHaveBeenCalledWith(srv, MISAO_PANE, 0, 10);
    expect(tmux.captureScreen).not.toHaveBeenCalled();
    expect(tmux.sendTextToHandle).toHaveBeenCalledWith(srv, TMUX_PANE, 'hi');
    expect(misao.sendTextToHandle).not.toHaveBeenCalled();
  });

  it('creates in opts.kind, or in the server default when it is omitted', async () => {
    const tmuxDefault = setup();
    await tmuxDefault.routing.openWorkspace(tmuxDefault.srv, 'a', { kind: 'misao' });
    await tmuxDefault.routing.openWorkspace(tmuxDefault.srv, 'b');
    expect(tmuxDefault.misao.openWorkspace).toHaveBeenCalledTimes(1);
    expect(tmuxDefault.tmux.openWorkspace).toHaveBeenCalledTimes(1);

    const misaoDefault = setup({ defaultMux: 'misao' });
    await misaoDefault.routing.openWindow(misaoDefault.srv, 'ws', 'w');
    await misaoDefault.routing.closeWorkspace(misaoDefault.srv, 'ws', { kind: 'tmux' });
    await misaoDefault.routing.renameWorkspace(misaoDefault.srv, 'a', 'b');
    await misaoDefault.routing.resolveRef(misaoDefault.srv, 'ws:w', { kind: 'tmux' });
    expect(misaoDefault.misao.openWindow).toHaveBeenCalledTimes(1);
    expect(misaoDefault.tmux.closeWorkspace).toHaveBeenCalledTimes(1);
    expect(misaoDefault.misao.renameWorkspace).toHaveBeenCalledTimes(1);
    expect(misaoDefault.tmux.resolveRef).toHaveBeenCalledTimes(1);
  });

  it('lets the owning driver refuse an operation only it knows (tmux-only zoom on a misao pane)', async () => {
    const unsupported = new Error('does not support zoomPaneByHandle');
    const misao = fakeDriver('misao', { zoomPaneByHandle: vi.fn(async () => { throw unsupported; }) });
    const { routing, srv, tmux } = setup({ misao });
    await expect(routing.zoomPaneByHandle(srv, MISAO_PANE)).rejects.toBe(unsupported);
    expect(tmux.zoomPaneByHandle).not.toHaveBeenCalled();
  });

  it('turns an unavailable driver into a rejected promise, not a synchronous throw', async () => {
    const { routing, srv } = setup({ misaoAvailable: false });
    await expect(routing.closeWindow(srv, misaoRef)).rejects.toBeInstanceOf(MuxDriverUnavailableError);
  });

  it('reports the default kind as its own kind and caps', () => {
    const misaoDefault = setup({ defaultMux: 'misao' });
    expect(misaoDefault.routing.kind).toBe('misao');
    expect(misaoDefault.routing.caps).toBe(misaoDefault.misao.caps);
  });
});

describe('RoutingMuxClient pane labels are decided per window, not by the default mux', () => {
  const labels = { windowId: 7, taskId: 3 };
  for (const defaultMux of ['tmux', 'misao'] as const) {
    it(`labels a misao window and leaves a tmux window alone on a ${defaultMux}-default server`, async () => {
      const tmux = fakeDriver('tmux', { labelWindowPanes: vi.fn(async () => { throw new Error('tmux keeps no pane labels'); }) });
      const { routing, srv, misao } = setup({ tmux, defaultMux });
      expect(routing.supportsPaneLabels).toBe(true);
      await routing.labelWindowPanes(srv, misaoRef, labels);
      await expect(routing.labelWindowPanes(srv, tmuxRef, labels)).resolves.toBeUndefined();
      expect(misao.labelWindowPanes).toHaveBeenCalledWith(srv, misaoRef, labels);
      expect(tmux.labelWindowPanes).not.toHaveBeenCalled();
    });
  }
});

describe('RoutingMuxClient merging', () => {
  it('concatenates the workspaces of every usable kind, stamped with their kind', async () => {
    const { routing, srv } = setup({
      tmux: fakeDriver('tmux', { listWorkspaces: vi.fn(async () => [workspace('same')]) }),
      misao: fakeDriver('misao', { listWorkspaces: vi.fn(async () => [workspace('same'), workspace('m')]) }),
    });
    const { workspaces, unavailable } = await routing.listWorkspacesDetailed(srv);
    expect(workspaces.map((w) => `${w.kind}:${w.name}`)).toEqual(['tmux:same', 'misao:same', 'misao:m']);
    expect(unavailable).toEqual([]);
  });

  it('returns the other kind when one fails, and says which failed and why', async () => {
    const { routing, srv } = setup({
      misao: fakeDriver('misao', { listWorkspaces: vi.fn(async () => { throw new MuxDriverUnavailableError('misao', 'daemon_unreachable'); }) }),
      tmux: fakeDriver('tmux', { listWorkspaces: vi.fn(async () => [workspace('t')]) }),
    });
    const { workspaces, unavailable } = await routing.listWorkspacesDetailed(srv);
    expect(workspaces.map((w) => w.name)).toEqual(['t']);
    expect(unavailable).toEqual([{ kind: 'misao', reason: 'daemon_unreachable', detail: expect.any(String) }]);
  });

  it('records a non-availability failure as driver_error, and still returns the other kind', async () => {
    const { routing, srv } = setup({
      tmux: fakeDriver('tmux', { listWorkspaces: vi.fn(async () => { throw new Error('tmux exploded'); }), listAllPanes: vi.fn(async () => { throw new Error('tmux exploded'); }) }),
      misao: fakeDriver('misao', { listWorkspaces: vi.fn(async () => [workspace('m')]), listAllPanes: vi.fn(async () => [{ paneId: `p_${ULID}` }]) }),
    });
    expect(await routing.listAllPanes(srv)).toEqual([{ paneId: `p_${ULID}` }]);
    expect((await routing.listWorkspacesDetailed(srv)).unavailable).toEqual([{ kind: 'tmux', reason: 'driver_error', detail: 'tmux exploded' }]);
  });

  it('reports a hosted kind that cannot be called now (stopped daemon) as unavailable, never as absent', async () => {
    const { routing, srv, misao } = setup({ misaoAvailable: false, tmux: fakeDriver('tmux', { listWorkspaces: vi.fn(async () => [workspace('t')]), listWorkspacesStrict: vi.fn(async () => [workspace('t')]) }) });
    const { workspaces, unavailable } = await routing.listWorkspacesDetailed(srv);
    expect(workspaces.map((w) => w.name)).toEqual(['t']);
    expect(unavailable).toEqual([{ kind: 'misao', reason: 'daemon_unreachable' }]);
    expect(misao.listWorkspaces).not.toHaveBeenCalled();
    // Strict lists the usable kinds only: a stopped non-default mux does not fail it.
    await routing.listWorkspacesStrict(srv);
    expect(misao.listWorkspacesStrict).not.toHaveBeenCalled();
  });

  it('propagates the error (the default kind\'s first) when every kind fails, instead of an empty list', async () => {
    const tmuxError = new Error('tmux down');
    const { routing, srv } = setup({
      tmux: fakeDriver('tmux', { listWorkspaces: vi.fn(async () => { throw tmuxError; }) }),
      misao: fakeDriver('misao', { listWorkspaces: vi.fn(async () => { throw new Error('misao down'); }) }),
    });
    await expect(routing.listWorkspaces(srv)).rejects.toBe(tmuxError);
  });

  it('keeps the Strict contract: any failing kind fails the call', async () => {
    const misaoError = new Error('strict misao failure');
    const { routing, srv } = setup({
      tmux: fakeDriver('tmux', { listWorkspacesStrict: vi.fn(async () => [workspace('t')]) }),
      misao: fakeDriver('misao', { listWorkspacesStrict: vi.fn(async () => { throw misaoError; }) }),
    });
    await expect(routing.listWorkspacesStrict(srv)).rejects.toBe(misaoError);
  });

  it('installs and removes change hooks on every usable kind, and still reports a failure', async () => {
    const hookError = new Error('hooks failed');
    const { routing, srv, tmux, misao } = setup({ misao: fakeDriver('misao', { installChangeHooks: vi.fn(async () => { throw hookError; }) }) });
    await expect(routing.installChangeHooks(srv)).rejects.toBe(hookError);
    expect(tmux.installChangeHooks).toHaveBeenCalledTimes(1);
    await routing.uninstallChangeHooks(srv);
    expect(tmux.uninstallChangeHooks).toHaveBeenCalledTimes(1);
    expect(misao.uninstallChangeHooks).toHaveBeenCalledTimes(1);
  });
});

describe('RoutingMuxClient on a tmux-only server', () => {
  const agentServer = { name: 'agent1', type: 'agent', defaultMux: 'tmux' } as ServerConfig;

  it('uses only the tmux driver and never asks misao, even when the daemon is up', async () => {
    const { tmux, misao, registry } = setup({ tmux: fakeDriver('tmux', { listWorkspaces: vi.fn(async () => [workspace('t')]) }) });
    const routing = registry.resolve(agentServer);
    expect((await routing.listWorkspaces(agentServer)).map((w) => w.name)).toEqual(['t']);
    await routing.listAllPanes(agentServer);
    await routing.measurePanePids(agentServer);
    await routing.installChangeHooks(agentServer);
    expect(misao.listWorkspaces).not.toHaveBeenCalled();
    expect(misao.listAllPanes).not.toHaveBeenCalled();
    expect(misao.measurePanePids).not.toHaveBeenCalled();
    expect(misao.installChangeHooks).not.toHaveBeenCalled();
    expect(tmux.listAllPanes).toHaveBeenCalledTimes(1);
    expect((await routing.listWorkspacesDetailed(agentServer)).unavailable).toEqual([]);
  });

  it('propagates the tmux driver\'s own error untouched (no wrapping, no empty fallback)', async () => {
    const failure = Object.assign(new Error('agent unreachable'), { name: 'AgentUnreachableError' });
    const { registry } = setup({ tmux: fakeDriver('tmux', { listWorkspaces: vi.fn(async () => { throw failure; }), measurePanePids: vi.fn(async () => { throw failure; }) }) });
    const routing = registry.resolve(agentServer);
    await expect(routing.listWorkspaces(agentServer)).rejects.toBe(failure);
    await expect(routing.measurePanePids(agentServer)).rejects.toBe(failure);
  });

  it('lists a local tmux server without a reachable daemon through the tmux driver alone, reporting misao as unavailable', async () => {
    const { routing, srv, tmux } = setup({ misaoAvailable: false, tmux: fakeDriver('tmux', { listWorkspaces: vi.fn(async () => [workspace('t')]) }) });
    const { workspaces, unavailable } = await routing.listWorkspacesDetailed(srv);
    expect(workspaces.map((w) => w.name)).toEqual(['t']);
    expect(unavailable).toEqual([{ kind: 'misao', reason: 'daemon_unreachable' }]);
    expect(tmux.listWorkspaces).toHaveBeenCalledWith(srv);
  });

  it('is an IMuxClient: the registry hands out a RoutingMuxClient', () => {
    const { routing } = setup();
    expect(routing).toBeInstanceOf(RoutingMuxClient);
  });
});
