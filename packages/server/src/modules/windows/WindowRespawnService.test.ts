import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { WindowRespawnService } from './WindowRespawnService';
import type { Window, IWindowRepository } from './Window';
import type { ServerConfig } from '../servers/Server';
import type { ITaskRepository, Task } from '../tasks/Task';
import type { IUnitRepository, Unit } from '../units/Unit';
import type { IProjectServerRepository } from '../projects/ProjectServer';
import type { TransportFactory } from '../servers/transport/TransportFactory';

function makeWindow(overrides: Partial<Window> = {}): Window {
  return {
    id: 1,
    ownerType: 'task',
    projectId: null,
    taskId: null,
    serverName: 'local-server',
    tmuxTarget: 'azito:task-1.1',
    label: 'task-1',
    isPrimary: true,
    windowType: 'agent',
    workerType: 'claude',
    workerModel: 'opus',
    agentSessionId: null,
    launchCommand: null,
    workingDirectory: null,
    paneLayout: null,
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: 'local-server',
    type: 'local',
    host: null,
    agentPort: null,
    agentToken: null,
    agentVersion: null,
    sshHost: null,
    sshHostFingerprint: null,
  muxRuntime: 'system',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    projectId: 1,
    unitId: null,
    serverName: null,
    title: 'Test task',
    description: null,
    status: 'open',
    currentPhase: null,
    selfReviewCount: 0,
    priority: 0,
    tmuxWindow: null,
    selfReviewMaxAttempts: null,
    requirePlanApproval: false,
    source: 'local',
    sourceRef: null,
    worktreePath: null,
    worktreeBranch: null,
    baseBranch: null,
    targetBranch: null,
    skipPr: false,
    workingDirectory: null,
    branch: null,
    planMarkdown: null,
    pendingQuestions: null,
    changedFiles: null,
    summaryJson: null,
    prUrl: null,
    agentSessionId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeUnit(overrides: Partial<Unit> = {}): Unit {
  return {
    id: 10,
    name: 'claude-default',
    unitType: 'devops',
    systemPrompt: null,
    selfReviewMaxAttempts: 2,
    reviewSubagent: null,
    implementSubagent: null,
    phaseConfig: null,
    workerType: 'claude',
    workerModel: 'opus',
    workerExtraArgs: null,
    workerExecutionMode: 'tmux-pipe',
    workerRuntime: 'tui',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function buildService(opts: {
  window: Window;
  task?: Task | null;
  unit?: Unit | null;
  projectServerRepo?: Pick<IProjectServerRepository, 'find'>;
  transportFactory?: Pick<TransportFactory, 'getTransport'>;
}) {
  const windowRepo: IWindowRepository = {
    add: vi.fn(() => 1),
    findAll: vi.fn(() => []),
    findById: vi.fn(() => opts.window),
    findByProject: vi.fn(() => []),
    findByTask: vi.fn(() => []),
    findByTaskIds: vi.fn(() => new Map()),
    findAgentSessionIdsByServer: vi.fn(() => new Set<string>()),
    findByServerAndTarget: vi.fn(() => undefined),
    update: vi.fn(),
    updateAgentSessionIdByWindow: vi.fn(),
    remove: vi.fn(),
    removeByServerAndTarget: vi.fn(() => 0),
    updatePaneLayout: vi.fn(),
  };

  const sentCommands: string[] = [];
  const tmux = {
    listSessions: vi.fn(async () => [{ name: 'azito', windowCount: 0, attached: false, created: 0, windows: [] as { name: string; index: number; active: boolean; panes: unknown[]; activity: number }[] }]),
    createSession: vi.fn(async (_server: unknown, _session: string, options?: { windowName?: string; exactName?: boolean }) => ({
      windowName: options?.exactName && options.windowName ? options.windowName : `${options?.windowName || 'win'}--rand`,
    })),
    createWindow: vi.fn(async (_server: unknown, _session: string, baseName?: string, options?: { exactName?: boolean }) => ({
      windowName: options?.exactName && baseName ? baseName : `${baseName || 'win'}-new`,
    })),
    killWindow: vi.fn(async () => ({})),
    sendKeys: vi.fn(async (_server: unknown, _target: string, keys: string[]) => {
      sentCommands.push(keys[0]);
    }),
    splitPane: vi.fn(async () => {}),
    resolvePaneId: vi.fn(async () => '%0'),
    listPaneIds: vi.fn(async () => [{ index: 0, paneId: '%0' }]),
    execCommand: vi.fn(async () => ({ stdout: '' })),
  };

  const sessionStrategyFactory = {
    create: vi.fn(() => ({
      supportsSession: true,
      buildRespawnCommand: vi.fn(() => 'claude --resume abc --dangerously-skip-permissions'),
    })),
  };

  const taskRepo: Pick<ITaskRepository, 'findById'> = {
    findById: vi.fn(() => opts.task ?? null),
  };

  const unitRepo: Pick<IUnitRepository, 'findById'> = {
    findById: vi.fn(() => opts.unit ?? null),
  };

  const clearExitMarker = vi.fn();
  const supervisorRegistry = { clearExitMarker } as any;

  const service = new WindowRespawnService(
    windowRepo,
    tmux as any,
    sessionStrategyFactory as any,
    taskRepo as any,
    unitRepo as any,
    supervisorRegistry,
    undefined,
    opts.projectServerRepo as any,
    opts.transportFactory as any,
  );

  return { service, windowRepo, tmux, sentCommands, clearExitMarker };
}

describe('WindowRespawnService.respawn — supervisor wrap', () => {
  it('wraps the respawn command for agent windows on a local server', async () => {
    const task = makeTask({ id: 5, unitId: 10 });
    const unit = makeUnit({ id: 10 });
    const win = makeWindow({ taskId: 5, windowType: 'agent', workerType: 'claude' });
    const { service, sentCommands, clearExitMarker } = buildService({ window: win, task, unit });

    await service.respawn(1, makeServer());

    expect(sentCommands).toHaveLength(1);
    expect(sentCommands[0]).toMatch(/supervisor/);
    expect(sentCommands[0]).toContain('--task-id 5');
    expect(sentCommands[0]).toContain('--unit-id 10');
    expect(sentCommands[0]).toContain("-- 'claude --resume abc --dangerously-skip-permissions'");
    expect(clearExitMarker).toHaveBeenCalledWith('local-server', 'azito:task-1');
  });

  it('does not wrap terminal windows', async () => {
    const win = makeWindow({ windowType: 'terminal', workerType: null });
    const { service, sentCommands, clearExitMarker } = buildService({ window: win });

    await service.respawn(1, makeServer());

    expect(sentCommands).toHaveLength(0);
    expect(clearExitMarker).not.toHaveBeenCalled();
  });

  it('wraps agent windows without taskId (manually-created)', async () => {
    const win = makeWindow({ taskId: null, windowType: 'agent', workerType: 'claude' });
    const { service, sentCommands } = buildService({ window: win });

    await service.respawn(1, makeServer());

    expect(sentCommands).toHaveLength(1);
    expect(sentCommands[0]).toMatch(/supervisor/);
    expect(sentCommands[0]).not.toContain('--task-id');
    expect(sentCommands[0]).not.toContain('--unit-id');
  });

  it('wraps generic agent windows (workerType=generic)', async () => {
    const win = makeWindow({ taskId: null, windowType: 'agent', workerType: 'generic' });
    const { service, sentCommands } = buildService({ window: win });

    await service.respawn(1, makeServer());

    expect(sentCommands).toHaveLength(1);
    expect(sentCommands[0]).toMatch(/supervisor/);
  });

  it('includes taskId and unitId from the task/unit chain', async () => {
    const task = makeTask({ id: 5, unitId: 10 });
    const unit = makeUnit({ id: 10 });
    const win = makeWindow({ taskId: 5, windowType: 'agent', workerType: 'claude' });
    const { service, sentCommands } = buildService({ window: win, task, unit });

    await service.respawn(1, makeServer());

    expect(sentCommands[0]).toContain('--task-id 5');
    expect(sentCommands[0]).toContain('--unit-id 10');
  });

  it('respawn only sends keys once even when sibling rows share the same target', async () => {
    const win = makeWindow({ id: 1, taskId: 5, windowType: 'agent', workerType: 'claude' });
    const { service, tmux } = buildService({ window: win, task: makeTask({ id: 5 }) });

    await service.respawn(1, makeServer());

    expect(tmux.sendKeys).toHaveBeenCalledTimes(1);
  });
});

describe('WindowRespawnService.respawn — window name preservation', () => {
  it('preserves the original tmux window name on respawn', async () => {
    const win = makeWindow({ tmuxTarget: 'azito:task-1--ab12.1' });
    const { service, windowRepo } = buildService({ window: win });

    const result = await service.respawn(1, makeServer());

    expect(result.tmuxTarget).toBe('azito:task-1--ab12.1');
    expect(windowRepo.update).toHaveBeenCalledWith(1, { tmuxTarget: 'azito:task-1--ab12.1' });
  });

  it('kills an existing window with the same name before recreating', async () => {
    const win = makeWindow({ tmuxTarget: 'azito:task-1--ab12.1' });
    const { service, tmux } = buildService({ window: win });
    tmux.listSessions.mockResolvedValue([{
      name: 'azito',
      windowCount: 1,
      attached: false,
      created: 0,
      windows: [{ name: 'task-1--ab12', index: 0, active: true, panes: [], activity: 0 }],
    }]);

    await service.respawn(1, makeServer());

    expect(tmux.killWindow).toHaveBeenCalledWith(expect.anything(), 'azito:task-1--ab12');
    expect(tmux.createWindow).toHaveBeenCalledWith(
      expect.anything(), 'azito', 'task-1--ab12', { exactName: true },
    );
  });

  it('throws on invalid tmuxTarget without window part', async () => {
    const win = makeWindow({ tmuxTarget: 'azito' });
    const { service } = buildService({ window: win });

    await expect(service.respawn(1, makeServer())).rejects.toThrow('Invalid tmuxTarget');
  });

  it('creates a missing session with the target window and leaves no orphan', async () => {
    // `tmux new-session` always creates a window. Creating the session and then
    // adding the real window separately stranded that first window as a bare
    // shell nobody manages (observed as a stray `win--xxxx` after a respawn).
    const win = makeWindow({ tmuxTarget: 'azito:task-1--ab12.1' });
    const { service, tmux } = buildService({ window: win });
    tmux.listSessions.mockResolvedValue([]);

    const result = await service.respawn(1, makeServer());

    expect(tmux.createSession).toHaveBeenCalledWith(
      expect.anything(), 'azito', { windowName: 'task-1--ab12', exactName: true },
    );
    expect(tmux.createWindow).not.toHaveBeenCalled();
    expect(result.tmuxTarget).toBe('azito:task-1--ab12.1');
  });
});

describe('WindowRespawnService.respawn — containment (Issue #27)', () => {
  // Containment resolves real paths via fs.realpath (LocalPathResolver), so
  // these fixtures need to exist on disk — a literal string like '/work'
  // would make every check fail closed with "Cannot verify ... (ENOENT)".
  let rootDir: string;

  function makeProjectServerRepo(workingDirectory: string | null): Pick<IProjectServerRepository, 'find'> {
    return { find: vi.fn(() => ({ projectId: 1, serverName: 'local-server', workingDirectory, branch: 'main', tmuxSession: 'azito' })) };
  }

  function makeTransportFactory(): Pick<TransportFactory, 'getTransport'> {
    // Only exercised for non-local server types; local respawns resolve via
    // fs.realpath directly and never touch the transport.
    return { getTransport: vi.fn(() => ({})) } as unknown as Pick<TransportFactory, 'getTransport'>;
  }

  beforeEach(() => {
    rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'azito-window-respawn-')));
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('rejects a single-pane window.workingDirectory that escapes the project root', async () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'azito-window-respawn-outside-'));
    try {
      const win = makeWindow({ projectId: 1, taskId: null, windowType: 'terminal', workerType: null, workingDirectory: outsideDir });
      const { service } = buildService({
        window: win,
        projectServerRepo: makeProjectServerRepo(rootDir),
        transportFactory: makeTransportFactory(),
      });

      await expect(service.respawn(1, makeServer())).rejects.toThrow(/escapes the allowed directory/);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('cds into the resolved path for a single-pane window inside the project root', async () => {
    const win = makeWindow({ projectId: 1, taskId: null, windowType: 'terminal', workerType: null, workingDirectory: rootDir });
    const { service, sentCommands } = buildService({
      window: win,
      projectServerRepo: makeProjectServerRepo(rootDir),
      transportFactory: makeTransportFactory(),
    });

    await service.respawn(1, makeServer());

    expect(sentCommands).toContain(`cd ${rootDir}`);
  });

  it('accepts a child directory named "..cache" (regression: isPathContained must not over-reject)', async () => {
    const dotDotCacheDir = path.join(rootDir, '..cache');
    mkdirSync(dotDotCacheDir);
    const win = makeWindow({ projectId: 1, taskId: null, windowType: 'terminal', workerType: null, workingDirectory: dotDotCacheDir });
    const { service, sentCommands } = buildService({
      window: win,
      projectServerRepo: makeProjectServerRepo(rootDir),
      transportFactory: makeTransportFactory(),
    });

    await service.respawn(1, makeServer());

    expect(sentCommands).toContain(`cd ${dotDotCacheDir}`);
  });

  it('rejects a multi-pane layout pane.workingDirectory that escapes the project root', async () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'azito-window-respawn-outside-'));
    try {
      const win = makeWindow({
        projectId: 1,
        taskId: null,
        windowType: 'terminal',
        workerType: null,
        workingDirectory: rootDir,
        paneLayout: {
          layout: 'even-horizontal',
          panes: [
            { index: 0, command: null, workingDirectory: rootDir, title: null },
            { index: 1, command: null, workingDirectory: outsideDir, title: null },
          ],
        },
      });
      const { service, tmux } = buildService({
        window: win,
        projectServerRepo: makeProjectServerRepo(rootDir),
        transportFactory: makeTransportFactory(),
      });
      // Default mock only reports one pane id (index 0) regardless of the
      // requested pane count — this test needs both panes mapped so pane
      // index 1's (rejected) workingDirectory is actually reached.
      tmux.listPaneIds.mockResolvedValue([{ index: 0, paneId: '%0' }, { index: 1, paneId: '%1' }]);

      await expect(service.respawn(1, makeServer())).rejects.toThrow(/escapes the allowed directory/);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('skips verification (legacy behavior) when the project has no configured working directory', async () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'azito-window-respawn-outside-'));
    try {
      const win = makeWindow({ projectId: 1, taskId: null, windowType: 'terminal', workerType: null, workingDirectory: outsideDir });
      const { service, sentCommands } = buildService({
        window: win,
        projectServerRepo: makeProjectServerRepo(null),
        transportFactory: makeTransportFactory(),
      });

      await service.respawn(1, makeServer());

      expect(sentCommands).toContain(`cd ${outsideDir}`);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('skips verification (legacy behavior) when projectServerRepo/transportFactory are not wired at all', async () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'azito-window-respawn-outside-'));
    try {
      const win = makeWindow({ projectId: 1, taskId: null, windowType: 'terminal', workerType: null, workingDirectory: outsideDir });
      const { service, sentCommands } = buildService({ window: win });

      await service.respawn(1, makeServer());

      expect(sentCommands).toContain(`cd ${outsideDir}`);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
