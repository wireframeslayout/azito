import { describe, it, expect, vi } from 'vitest';
import { WindowActivityStatusService } from './WindowActivityStatusService';
import type { Window, IWindowRepository } from './Window';
import type { IServerRepository, ServerConfig } from '../servers/Server';
import type { WindowSessionResolver } from '../transcripts/WindowSessionResolver';

const LOCAL_SERVER: ServerConfig = {
  name: 'local',
  type: 'local',
  host: null,
  agentPort: null,
  agentToken: null,
  agentVersion: null,
  sshHost: null,
  muxRuntime: 'system',
  sshHostFingerprint: null,
  createdAt: '2026-01-01T00:00:00Z',
};

const AGENT_SERVER: ServerConfig = { ...LOCAL_SERVER, name: 'remote', type: 'agent' };

function buildWindow(overrides: Partial<Window> = {}): Window {
  return {
    id: 1,
    ownerType: 'project',
    projectId: 1,
    taskId: null,
    serverName: 'local',
    tmuxTarget: 'main:0',
    label: null,
    isPrimary: true,
    windowType: 'agent',
    workerType: 'claude',
    workerModel: null,
    agentSessionId: null,
    launchCommand: null,
    workingDirectory: null,
    paneLayout: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function buildDeps(
  windows: Window[],
  servers: ServerConfig[],
  statusByWindowId: Map<number, 'working' | 'idle' | 'offline'>,
) {
  const windowRepo = { findAll: () => windows } as unknown as IWindowRepository;
  const serverRepo = { findByName: (name: string) => servers.find((s) => s.name === name) ?? null } as unknown as IServerRepository;
  // The resolver now answers with the ending it observed alongside the coarse status
  // (P3); these tests only exercise the status, so the outcome fields stay null.
  const getActivityStatus = vi.fn(async (w: Window, _snapshot?: unknown) => ({
    status: statusByWindowId.get(w.id) ?? 'offline',
    completedAt: null,
    interruptedAt: null,
  }));
  // Shared per-server snapshot (list-panes -a + ps, taken once per server) —
  // its contents are opaque to this service, which only forwards it.
  const captureActivityProbeSnapshot = vi.fn(async () => ({ allPanes: [], psEntries: [] }));
  const windowSessionResolver = { getActivityStatus, captureActivityProbeSnapshot } as unknown as WindowSessionResolver;
  return { windowRepo, serverRepo, windowSessionResolver, getActivityStatus, captureActivityProbeSnapshot };
}

describe('WindowActivityStatusService', () => {
  it('returns an entry per local agent window with its resolved status', async () => {
    const windows = [buildWindow({ id: 1, serverName: 'local', tmuxTarget: 'main:0' })];
    const { windowRepo, serverRepo, windowSessionResolver } = buildDeps(windows, [LOCAL_SERVER], new Map([[1, 'working']]));
    const service = new WindowActivityStatusService(windowRepo, serverRepo, windowSessionResolver);
    const result = await service.list();
    expect(result).toEqual([
      { windowId: 1, serverName: 'local', target: 'main:0', status: 'working', completedAt: null, interruptedAt: null, taskId: undefined, projectId: 1, label: undefined },
    ]);
  });

  it('excludes terminal (non-agent) windows', async () => {
    const windows = [buildWindow({ id: 1, windowType: 'terminal', workerType: null })];
    const { windowRepo, serverRepo, windowSessionResolver, getActivityStatus } = buildDeps(windows, [LOCAL_SERVER], new Map());
    const service = new WindowActivityStatusService(windowRepo, serverRepo, windowSessionResolver);
    const result = await service.list();
    expect(result).toEqual([]);
    expect(getActivityStatus).not.toHaveBeenCalled();
  });

  it('excludes windows on non-local servers', async () => {
    const windows = [buildWindow({ id: 1, serverName: 'remote' })];
    const { windowRepo, serverRepo, windowSessionResolver, getActivityStatus } = buildDeps(windows, [AGENT_SERVER], new Map());
    const service = new WindowActivityStatusService(windowRepo, serverRepo, windowSessionResolver);
    const result = await service.list();
    expect(result).toEqual([]);
    expect(getActivityStatus).not.toHaveBeenCalled();
  });

  it('dedups multiple DB rows pointing at the same server+target, preferring the task-owned row', async () => {
    const windows = [
      buildWindow({ id: 1, ownerType: 'project', projectId: 5, taskId: null, tmuxTarget: 'main:0' }),
      buildWindow({ id: 2, ownerType: 'task', projectId: null, taskId: 9, tmuxTarget: 'main:0' }),
    ];
    const { windowRepo, serverRepo, windowSessionResolver, getActivityStatus } = buildDeps(windows, [LOCAL_SERVER], new Map([[2, 'idle']]));
    const service = new WindowActivityStatusService(windowRepo, serverRepo, windowSessionResolver);
    const result = await service.list();
    expect(result).toEqual([
      { windowId: 2, serverName: 'local', target: 'main:0', status: 'idle', completedAt: null, interruptedAt: null, taskId: 9, projectId: undefined, label: undefined },
    ]);
    expect(getActivityStatus).toHaveBeenCalledTimes(1);
  });

  it('dedups project/task-owned rows for the same window even when only the task-owned row carries a pane suffix', async () => {
    // Reproduces the real-world shape (Issue #338): a project-owned window row is
    // stored without a pane suffix (`test:win--1m1u`) while its task-owned
    // counterpart for the exact same tmux window is stored with one
    // (`test:win--1m1u.1`, added at window-creation time). Keying the dedup map on
    // the raw tmuxTarget (pre-fix) treated these as two different windows, so both
    // survived and the service emitted a duplicate entry under a second `target`
    // string the frontend's process-based supplement could never reconcile away —
    // even after the underlying tmux window was gone, that duplicate's own key
    // stuck around independently of the primary (AgentActivityMonitor) source.
    const windows = [
      buildWindow({ id: 1, ownerType: 'project', projectId: 5, taskId: null, tmuxTarget: 'test:win--1m1u' }),
      buildWindow({ id: 2, ownerType: 'task', projectId: null, taskId: 9, tmuxTarget: 'test:win--1m1u.1' }),
    ];
    const { windowRepo, serverRepo, windowSessionResolver, getActivityStatus } = buildDeps(windows, [LOCAL_SERVER], new Map([[2, 'offline']]));
    const service = new WindowActivityStatusService(windowRepo, serverRepo, windowSessionResolver);
    const result = await service.list();
    expect(result).toEqual([
      { windowId: 2, serverName: 'local', target: 'test:win--1m1u', status: 'offline', completedAt: null, interruptedAt: null, taskId: 9, projectId: undefined, label: undefined },
    ]);
    expect(getActivityStatus).toHaveBeenCalledTimes(1);
  });

  it('strips a trailing `.N` unconditionally, merging rows regardless of their ownership shape', async () => {
    // The strip is deliberately unconditional (see the dedup doc comment): both
    // rows here are project-owned — for two *different* projects — and would be
    // left un-merged by an ownership-based heuristic, but they still collapse to
    // one entry keyed on the stripped target. The accepted cost of that choice is
    // documented as a known limitation: a window whose real name ends in `.N`
    // (only possible via an imported external tmux session) is indistinguishable
    // here from a pane suffix. Preserving the raw form was tried and reverted —
    // `WindowSessionResolver.splitWindowTarget()` strips unconditionally
    // downstream, so it protected nothing.
    const windows = [
      buildWindow({ id: 1, ownerType: 'project', projectId: 5, taskId: null, tmuxTarget: 'main:agent-1' }),
      buildWindow({ id: 2, ownerType: 'project', projectId: 6, taskId: null, tmuxTarget: 'main:agent-1.1' }),
    ];
    const { windowRepo, serverRepo, windowSessionResolver, getActivityStatus } = buildDeps(windows, [LOCAL_SERVER], new Map([[1, 'idle'], [2, 'working']]));
    const service = new WindowActivityStatusService(windowRepo, serverRepo, windowSessionResolver);
    const result = await service.list();
    // Neither row is task-owned, so the first-registered row (id 1) wins the dedup
    // preference ("only overwrite when the new row is task-owned and the existing
    // one isn't").
    expect(result).toEqual([
      { windowId: 1, serverName: 'local', target: 'main:agent-1', status: 'idle', completedAt: null, interruptedAt: null, taskId: undefined, projectId: 5, label: undefined },
    ]);
    expect(getActivityStatus).toHaveBeenCalledTimes(1);
  });

  it('caches results for the 10s TTL and recomputes once it expires', async () => {
    // The TTL must stay below AgentActivityMonitor's Tier 4 refresh interval
    // (15s) — a longer one would re-create the poll/cache phase problem where a
    // state change takes two periods to surface.
    vi.useFakeTimers();
    try {
      const windows = [buildWindow({ id: 1 })];
      const { windowRepo, serverRepo, windowSessionResolver, getActivityStatus } = buildDeps(windows, [LOCAL_SERVER], new Map([[1, 'working']]));
      const service = new WindowActivityStatusService(windowRepo, serverRepo, windowSessionResolver);

      await service.list();
      await service.list();
      expect(getActivityStatus).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(9_900);
      await service.list();
      expect(getActivityStatus).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(200);
      await service.list();
      expect(getActivityStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes the expensive snapshot once per server, not once per window', async () => {
    const windows = [
      buildWindow({ id: 1, tmuxTarget: 'main:0' }),
      buildWindow({ id: 2, tmuxTarget: 'main:1' }),
      buildWindow({ id: 3, tmuxTarget: 'main:2' }),
    ];
    const { windowRepo, serverRepo, windowSessionResolver, getActivityStatus, captureActivityProbeSnapshot } =
      buildDeps(windows, [LOCAL_SERVER], new Map([[1, 'working'], [2, 'idle'], [3, 'working']]));
    const service = new WindowActivityStatusService(windowRepo, serverRepo, windowSessionResolver);

    const result = await service.list();
    expect(result.map((e) => e.status)).toEqual(['working', 'idle', 'working']);
    expect(captureActivityProbeSnapshot).toHaveBeenCalledTimes(1);
    expect(getActivityStatus).toHaveBeenCalledTimes(3);
    // Every window classification is handed the shared snapshot.
    for (const call of getActivityStatus.mock.calls) expect(call[1]).toEqual({ allPanes: [], psEntries: [] });
  });

  it('skips the probe entirely when no local agent window exists', async () => {
    const windows = [buildWindow({ id: 1, serverName: 'remote' })];
    const { windowRepo, serverRepo, windowSessionResolver, captureActivityProbeSnapshot } =
      buildDeps(windows, [AGENT_SERVER], new Map());
    const service = new WindowActivityStatusService(windowRepo, serverRepo, windowSessionResolver);

    expect(await service.list()).toEqual([]);
    expect(captureActivityProbeSnapshot).not.toHaveBeenCalled();
  });

  it('reports offline for a server whose snapshot could not be taken', async () => {
    const windows = [buildWindow({ id: 1 })];
    const { windowRepo, serverRepo, windowSessionResolver, getActivityStatus, captureActivityProbeSnapshot } =
      buildDeps(windows, [LOCAL_SERVER], new Map([[1, 'working']]));
    (captureActivityProbeSnapshot as unknown as { mockResolvedValue: (v: null) => void }).mockResolvedValue(null);
    const service = new WindowActivityStatusService(windowRepo, serverRepo, windowSessionResolver);

    expect((await service.list())[0].status).toBe('offline');
    expect(getActivityStatus).not.toHaveBeenCalled();
  });

  it('isolates a single window failure instead of failing the whole snapshot', async () => {
    const windows = [buildWindow({ id: 1, tmuxTarget: 'main:0' }), buildWindow({ id: 2, tmuxTarget: 'main:1' })];
    const { windowRepo, serverRepo, windowSessionResolver, getActivityStatus } =
      buildDeps(windows, [LOCAL_SERVER], new Map([[2, 'working']]));
    getActivityStatus.mockImplementation(async (w: Window) => {
      if (w.id === 1) throw new Error('ps exploded');
      return { status: 'working', completedAt: null, interruptedAt: null };
    });
    const service = new WindowActivityStatusService(windowRepo, serverRepo, windowSessionResolver);

    const result = await service.list();
    expect(result.map((e) => [e.windowId, e.status])).toEqual([[1, 'offline'], [2, 'working']]);
  });
});
