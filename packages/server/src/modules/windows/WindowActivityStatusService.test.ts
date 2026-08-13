import { describe, it, expect, vi } from 'vitest';
import { WindowActivityStatusService } from './WindowActivityStatusService';
import type { Window, IWindowRepository } from './Window';
import type { IServerRepository, ServerConfig } from '../servers/Server';
import type { WindowSessionResolver } from '../transcripts/WindowSessionResolver';
import type { TmuxClient, TmuxPaneInfo } from '../tmux/TmuxClient';

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

/**
 * `tmuxPanesByServer` fakes `TmuxClient.listAllPanes()` per serverName. Omitted servers resolve
 * to `[]` (query succeeds but finds nothing — same as no window existing under either raw or
 * stripped form, which falls through to the ownership heuristic). Pass a serverName mapped to a
 * function that throws to simulate a failed tmux query (also falls back to the heuristic).
 */
function buildDeps(
  windows: Window[],
  servers: ServerConfig[],
  statusByWindowId: Map<number, 'working' | 'idle' | 'offline'>,
  tmuxPanesByServer: Record<string, TmuxPaneInfo[] | (() => TmuxPaneInfo[])> = {},
) {
  const windowRepo = { findAll: () => windows } as unknown as IWindowRepository;
  const serverRepo = { findByName: (name: string) => servers.find((s) => s.name === name) ?? null } as unknown as IServerRepository;
  const getActivityStatus = vi.fn(async (w: Window) => statusByWindowId.get(w.id) ?? 'offline');
  const windowSessionResolver = { getActivityStatus } as unknown as WindowSessionResolver;
  const listAllPanes = vi.fn(async (server: ServerConfig) => {
    const fixture = tmuxPanesByServer[server.name];
    if (typeof fixture === 'function') return fixture();
    return fixture ?? [];
  });
  const tmuxClient = { listAllPanes } as unknown as TmuxClient;
  return { windowRepo, serverRepo, windowSessionResolver, getActivityStatus, tmuxClient, listAllPanes };
}

function buildPane(overrides: Partial<TmuxPaneInfo>): TmuxPaneInfo {
  return {
    paneId: '%1',
    sessionName: 'main',
    windowIndex: 0,
    windowName: 'w0',
    paneIndex: 0,
    currentPath: '/proj',
    currentCommand: 'node',
    ...overrides,
  };
}

describe('WindowActivityStatusService', () => {
  it('returns an entry per local agent window with its resolved status', async () => {
    const windows = [buildWindow({ id: 1, serverName: 'local', tmuxTarget: 'main:0' })];
    const { windowRepo, serverRepo, windowSessionResolver, tmuxClient } = buildDeps(windows, [LOCAL_SERVER], new Map([[1, 'working']]));
    const service = new WindowActivityStatusService(windowRepo, serverRepo, windowSessionResolver, tmuxClient);
    const result = await service.list();
    expect(result).toEqual([
      { windowId: 1, serverName: 'local', target: 'main:0', status: 'working', taskId: undefined, projectId: 1, label: undefined },
    ]);
  });

  it('excludes terminal (non-agent) windows', async () => {
    const windows = [buildWindow({ id: 1, windowType: 'terminal', workerType: null })];
    const { windowRepo, serverRepo, windowSessionResolver, getActivityStatus, tmuxClient } = buildDeps(windows, [LOCAL_SERVER], new Map());
    const service = new WindowActivityStatusService(windowRepo, serverRepo, windowSessionResolver, tmuxClient);
    const result = await service.list();
    expect(result).toEqual([]);
    expect(getActivityStatus).not.toHaveBeenCalled();
  });

  it('excludes windows on non-local servers', async () => {
    const windows = [buildWindow({ id: 1, serverName: 'remote' })];
    const { windowRepo, serverRepo, windowSessionResolver, getActivityStatus, tmuxClient } = buildDeps(windows, [AGENT_SERVER], new Map());
    const service = new WindowActivityStatusService(windowRepo, serverRepo, windowSessionResolver, tmuxClient);
    const result = await service.list();
    expect(result).toEqual([]);
    expect(getActivityStatus).not.toHaveBeenCalled();
  });

  it('dedups multiple DB rows pointing at the same server+target, preferring the task-owned row', async () => {
    const windows = [
      buildWindow({ id: 1, ownerType: 'project', projectId: 5, taskId: null, tmuxTarget: 'main:0' }),
      buildWindow({ id: 2, ownerType: 'task', projectId: null, taskId: 9, tmuxTarget: 'main:0' }),
    ];
    const { windowRepo, serverRepo, windowSessionResolver, getActivityStatus, tmuxClient } = buildDeps(windows, [LOCAL_SERVER], new Map([[2, 'idle']]));
    const service = new WindowActivityStatusService(windowRepo, serverRepo, windowSessionResolver, tmuxClient);
    const result = await service.list();
    expect(result).toEqual([
      { windowId: 2, serverName: 'local', target: 'main:0', status: 'idle', taskId: 9, projectId: undefined, label: undefined },
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
    const { windowRepo, serverRepo, windowSessionResolver, getActivityStatus, tmuxClient } = buildDeps(windows, [LOCAL_SERVER], new Map([[2, 'offline']]));
    const service = new WindowActivityStatusService(windowRepo, serverRepo, windowSessionResolver, tmuxClient);
    const result = await service.list();
    expect(result).toEqual([
      { windowId: 2, serverName: 'local', target: 'test:win--1m1u', status: 'offline', taskId: 9, projectId: undefined, label: undefined },
    ]);
    expect(getActivityStatus).toHaveBeenCalledTimes(1);
  });

  it('does not strip a standalone window whose name itself ends in `.N` (no sibling row)', async () => {
    // `agent-1.1` here is the window's actual name, not a pane suffix on a
    // window called `agent-1` — no row is registered under the stripped form,
    // so it must survive as its own independent entry with its target intact.
    const windows = [
      buildWindow({ id: 1, ownerType: 'project', projectId: 5, taskId: null, tmuxTarget: 'main:agent-1.1' }),
    ];
    const { windowRepo, serverRepo, windowSessionResolver, getActivityStatus, tmuxClient } = buildDeps(windows, [LOCAL_SERVER], new Map([[1, 'idle']]));
    const service = new WindowActivityStatusService(windowRepo, serverRepo, windowSessionResolver, tmuxClient);
    const result = await service.list();
    expect(result).toEqual([
      { windowId: 1, serverName: 'local', target: 'main:agent-1.1', status: 'idle', taskId: undefined, projectId: 5, label: undefined },
    ]);
    expect(getActivityStatus).toHaveBeenCalledTimes(1);
  });

  it('does not merge two genuinely independent windows named `agent-1` and `agent-1.1` when their ownership is not complementary', async () => {
    // Limitation of the conservative (DB-only, no live tmux query) heuristic:
    // it approximates "same physical window" as "stripped form has a
    // complementary-owned (one task-owned, one project-owned) sibling row",
    // which is the one real production source of this duplication (a task
    // run's window also getting a project-scoped row, or vice versa — see the
    // dedup doc comment in WindowActivityStatusService). Two independently
    // registered windows that happen to share this exact naming pattern are
    // only mis-merged if they ALSO happen to have complementary ownership;
    // this test fixes the chosen (safer) behavior for the case where they
    // don't — both project-owned here, for two different projects — so both
    // rows are kept rather than one being silently dropped.
    const windows = [
      buildWindow({ id: 1, ownerType: 'project', projectId: 5, taskId: null, tmuxTarget: 'main:agent-1' }),
      buildWindow({ id: 2, ownerType: 'project', projectId: 6, taskId: null, tmuxTarget: 'main:agent-1.1' }),
    ];
    const { windowRepo, serverRepo, windowSessionResolver, getActivityStatus, tmuxClient } = buildDeps(windows, [LOCAL_SERVER], new Map([[1, 'idle'], [2, 'working']]));
    const service = new WindowActivityStatusService(windowRepo, serverRepo, windowSessionResolver, tmuxClient);
    const result = await service.list();
    expect(result).toEqual(expect.arrayContaining([
      { windowId: 1, serverName: 'local', target: 'main:agent-1', status: 'idle', taskId: undefined, projectId: 5, label: undefined },
      { windowId: 2, serverName: 'local', target: 'main:agent-1.1', status: 'working', taskId: undefined, projectId: 6, label: undefined },
    ]));
    expect(result).toHaveLength(2);
    expect(getActivityStatus).toHaveBeenCalledTimes(2);
  });

  describe('tmux entity query for conditional pane-suffix merging (Issue #338 codex review Important 2)', () => {
    it('does not merge when the raw target exists as a real tmux window name, even with complementary ownership (tmux entity check overrides the DB-only heuristic)', async () => {
      // Without a live tmux query, the ownership heuristic alone would merge
      // this pair (complementary owners sharing the stripped form `main:agent-1`
      // as a plausible sibling — see the other heuristic tests above). Here tmux
      // itself reports that a window literally named `agent-1.1` exists in
      // session `main`, which is decisive proof the `.1` is NOT a pane suffix —
      // it must survive as its own independent entry.
      const windows = [
        buildWindow({ id: 1, ownerType: 'project', projectId: 5, taskId: null, tmuxTarget: 'main:agent-1' }),
        buildWindow({ id: 2, ownerType: 'task', projectId: null, taskId: 9, tmuxTarget: 'main:agent-1.1' }),
      ];
      const { windowRepo, serverRepo, windowSessionResolver, getActivityStatus, tmuxClient, listAllPanes } = buildDeps(
        windows,
        [LOCAL_SERVER],
        new Map([[1, 'idle'], [2, 'working']]),
        { local: [buildPane({ sessionName: 'main', windowName: 'agent-1' }), buildPane({ sessionName: 'main', windowName: 'agent-1.1' })] },
      );
      const service = new WindowActivityStatusService(windowRepo, serverRepo, windowSessionResolver, tmuxClient);
      const result = await service.list();
      expect(result).toEqual(expect.arrayContaining([
        { windowId: 1, serverName: 'local', target: 'main:agent-1', status: 'idle', taskId: undefined, projectId: 5, label: undefined },
        { windowId: 2, serverName: 'local', target: 'main:agent-1.1', status: 'working', taskId: 9, projectId: undefined, label: undefined },
      ]));
      expect(result).toHaveLength(2);
      expect(listAllPanes).toHaveBeenCalledTimes(1);
    });

    it('merges when the raw target is absent from tmux but the stripped form exists as a real window name, even without complementary ownership', async () => {
      // Both rows are project-owned here — the ownership heuristic alone would
      // NOT merge this pair. tmux itself reports no window named
      // `agent-2.1` exists in session `main`, only `agent-2` does, which is
      // decisive proof the `.1` IS a pane suffix — the tmux entity check
      // overrides the heuristic and merges.
      const windows = [
        buildWindow({ id: 1, ownerType: 'project', projectId: 5, taskId: null, tmuxTarget: 'main:agent-2' }),
        buildWindow({ id: 2, ownerType: 'project', projectId: 6, taskId: null, tmuxTarget: 'main:agent-2.1' }),
      ];
      const { windowRepo, serverRepo, windowSessionResolver, getActivityStatus, tmuxClient, listAllPanes } = buildDeps(
        windows,
        [LOCAL_SERVER],
        new Map([[1, 'idle'], [2, 'working']]),
        { local: [buildPane({ sessionName: 'main', windowName: 'agent-2' })] },
      );
      const service = new WindowActivityStatusService(windowRepo, serverRepo, windowSessionResolver, tmuxClient);
      const result = await service.list();
      // Neither row is task-owned, so the first-registered row (id 1) wins the dedup
      // preference (see byKey's "only overwrite when the new row is task-owned and the
      // existing one isn't" rule) — merged under the stripped target either way.
      expect(result).toEqual([
        { windowId: 1, serverName: 'local', target: 'main:agent-2', status: 'idle', taskId: undefined, projectId: 5, label: undefined },
      ]);
      expect(getActivityStatus).toHaveBeenCalledTimes(1);
      expect(listAllPanes).toHaveBeenCalledTimes(1);
    });

    it('falls back to the ownership heuristic when the tmux query fails for that server', async () => {
      // listAllPanes throws (e.g. tmux command failure) — the service must not
      // propagate the error, and must fall back to the same DB-only ownership
      // heuristic used before this fix (complementary owners sharing the
      // stripped form merge; matches the earlier heuristic-only test).
      const windows = [
        buildWindow({ id: 1, ownerType: 'project', projectId: 5, taskId: null, tmuxTarget: 'test:win--1m1u' }),
        buildWindow({ id: 2, ownerType: 'task', projectId: null, taskId: 9, tmuxTarget: 'test:win--1m1u.1' }),
      ];
      const { windowRepo, serverRepo, windowSessionResolver, getActivityStatus, tmuxClient, listAllPanes } = buildDeps(
        windows,
        [LOCAL_SERVER],
        new Map([[2, 'offline']]),
        { local: () => { throw new Error('tmux command failed'); } },
      );
      const service = new WindowActivityStatusService(windowRepo, serverRepo, windowSessionResolver, tmuxClient);
      const result = await service.list();
      expect(result).toEqual([
        { windowId: 2, serverName: 'local', target: 'test:win--1m1u', status: 'offline', taskId: 9, projectId: undefined, label: undefined },
      ]);
      expect(getActivityStatus).toHaveBeenCalledTimes(1);
      expect(listAllPanes).toHaveBeenCalledTimes(1);
    });
  });

  it('caches results for 60s and does not re-query the resolver within the TTL', async () => {
    vi.useFakeTimers();
    try {
      const windows = [buildWindow({ id: 1 })];
      const { windowRepo, serverRepo, windowSessionResolver, getActivityStatus, tmuxClient } = buildDeps(windows, [LOCAL_SERVER], new Map([[1, 'working']]));
      const service = new WindowActivityStatusService(windowRepo, serverRepo, windowSessionResolver, tmuxClient);

      await service.list();
      await service.list();
      expect(getActivityStatus).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(61_000);
      await service.list();
      expect(getActivityStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
