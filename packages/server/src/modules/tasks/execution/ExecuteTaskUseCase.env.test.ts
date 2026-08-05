import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { ExecuteTaskUseCase } from './ExecuteTaskUseCase';
import { TurnSignalHub } from '../turns/TurnSignalHub';
import type { AgentTurn, AgentTurnEvent } from '../turns/AgentTurn';
import type { Task, ITaskRepository } from '../Task';
import type { Unit, IUnitRepository } from '../../units/Unit';
import type { ServerConfig, IServerRepository } from '../../servers/Server';
import type { ProjectDetail, IProjectRepository } from '../../projects/Project';
import type { IProjectServerRepository } from '../../projects/ProjectServer';

// ─── Fixtures ───

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    projectId: 1,
    unitId: 1,
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

function makeProject(overrides: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    id: 1,
    name: 'Test Project',
    slug: 'test-project',
    description: null,
    repositoryUrl: null,
    defaultBranch: 'main',
    sidekickPrompt: null,
    icon: null,
    color: null,
    defaultUnitId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    repositories: [],
    windows: [],
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
    workerType: null,
    workerModel: null,
    workerExtraArgs: null,
    workerExecutionMode: 'tmux-pipe',
    workerRuntime: 'tui',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ─── In-memory AgentTurn repo (for the http-signal followUp integration test below) ───
//
// A lightweight stand-in for SqliteAgentTurnRepository — avoids pulling in the
// full migration chain (see SqliteAgentTurnRepository.test.ts) just to exercise
// ExecuteTaskUseCase.followUp's http-signal branch end-to-end.

class FakeAgentTurnRepo {
  turns: AgentTurn[] = [];
  events: AgentTurnEvent[] = [];
  private nextId = 1;
  private nextEventId = 1;

  supersedeRunning(taskId: number, exceptTurnId?: number): void {
    for (const t of this.turns) {
      if (t.taskId === taskId && t.status === 'running' && t.id !== exceptTurnId) t.status = 'superseded';
    }
  }

  create(data: { taskId: number; unitId?: number | null; kind: 'phase' | 'follow_up'; phase?: string | null; nonce: string; serverName?: string | null; tmuxTarget?: string | null; outputFilePath?: string | null }): AgentTurn {
    const turn: AgentTurn = {
      id: this.nextId++,
      taskId: data.taskId,
      unitId: data.unitId ?? null,
      kind: data.kind,
      phase: data.phase ?? null,
      nonce: data.nonce,
      status: 'running',
      completionSource: null,
      confidence: null,
      serverName: data.serverName ?? null,
      tmuxTarget: data.tmuxTarget ?? null,
      outputFilePath: data.outputFilePath ?? null,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    this.turns.push(turn);
    return turn;
  }

  findById(id: number): AgentTurn | null {
    return this.turns.find((t) => t.id === id) ?? null;
  }

  markEnded(id: number, data: { status: AgentTurn['status']; completionSource: NonNullable<AgentTurn['completionSource']>; confidence: NonNullable<AgentTurn['confidence']>; endedAt?: string }): void {
    const t = this.turns.find((t) => t.id === id);
    if (!t) return;
    t.status = data.status;
    t.completionSource = data.completionSource;
    t.confidence = data.confidence;
    t.endedAt = data.endedAt ?? new Date().toISOString();
  }

  appendEvent(turnId: number, data: { type: string; payload?: string | null; source: string }): void {
    this.events.push({ id: this.nextEventId++, turnId, type: data.type, payload: data.payload ?? null, source: data.source, createdAt: new Date().toISOString() });
  }

  findLatestEventByType(turnId: number, type: string): AgentTurnEvent | null {
    const matches = this.events.filter((e) => e.turnId === turnId && e.type === type);
    return matches.length > 0 ? matches[matches.length - 1] : null;
  }
}

// ─── Test harness ───

function buildUseCase(opts: {
  task: Task;
  project: ProjectDetail | null;
  units: Unit[];
  projectServer?: { workingDirectory: string | null; branch: string | null; tmuxSession: string } | null;
  /** When set, overrides findByProject entirely (e.g. to simulate multiple project servers). */
  projectServersList?: Array<{ projectId: number; serverName: string; workingDirectory: string | null; branch: string | null; tmuxSession: string }>;
  /** When set, overrides the server returned by serverRepo.findByName (default: makeServer(), type 'local'). */
  server?: ServerConfig;
}) {
  const taskRepo: ITaskRepository = {
    findAll: vi.fn(() => []),
    findByProject: vi.fn(() => []),
    findByUnit: vi.fn(() => []),
    findByStatus: vi.fn(() => []),
    findAgentSessionIdsByServer: vi.fn(() => new Set<string>()),
    findById: vi.fn(() => opts.task),
    create: vi.fn(() => 1),
    update: vi.fn(),
    updateStatus: vi.fn(),
    updateCurrentPhase: vi.fn(),
    touch: vi.fn(),
    delete: vi.fn(),
  };

  const unitRepo: IUnitRepository = {
    findAll: vi.fn(() => opts.units),
    findById: vi.fn((id: number) => opts.units.find((u) => u.id === id) ?? null),
    create: vi.fn(() => 1),
    update: vi.fn(),
    delete: vi.fn(),
  };

  const serverRepo: IServerRepository = {
    findAll: vi.fn(() => [opts.server ?? makeServer()]),
    findByName: vi.fn(() => opts.server ?? makeServer()),
    create: vi.fn(),
    update: vi.fn(),
    updateAgentVersion: vi.fn(),
    updateFingerprint: vi.fn(),
    clearFingerprint: vi.fn(),
    delete: vi.fn(),
  };

  const projectRepo: IProjectRepository = {
    findAll: vi.fn(() => []),
    findById: vi.fn(() => opts.project),
    create: vi.fn(() => 1),
    update: vi.fn(),
    delete: vi.fn(),
    addRepository: vi.fn(() => 1),
    findRepositoryById: vi.fn(() => null),
    removeRepository: vi.fn(),
  };

  const projectServerRepo: IProjectServerRepository = {
    findByProject: vi.fn(() => opts.projectServersList ?? (opts.projectServer ? [{ projectId: 1, serverName: 'local-server', ...opts.projectServer }] : [])),
    findByServer: vi.fn(() => []),
    find: vi.fn(() => (opts.projectServer ? { projectId: 1, serverName: 'local-server', ...opts.projectServer } : null)),
    upsert: vi.fn(),
    remove: vi.fn(),
  };

  // sidekickLoader.findDefaultForPhase throws to short-circuit PhaseLoopRunner
  // before it touches git/worktree machinery — this test only exercises the
  // resolveExecutionEnv wiring in ExecuteTaskUseCase.execute(), which runs
  // synchronously before the phase loop starts.
  const sidekickLoader = {
    list: vi.fn(() => []),
    findByName: vi.fn(() => null),
    findDefaultForPhase: vi.fn(() => { throw new Error('phase loop should not run in this test'); }),
    invalidateCache: vi.fn(),
  };

  const logRepo = {
    append: vi.fn(),
    findByTask: vi.fn(() => []),
    findByUnit: vi.fn(() => []),
  };


  const tmux = {
    listSessions: vi.fn(async () => []),
    createSession: vi.fn(async () => {}),
    createWindow: vi.fn(async () => ({ windowName: 'w1' })),
    resolvePaneId: vi.fn(async () => '%0'),
    killPane: vi.fn(async () => {}),
    killWindow: vi.fn(async () => {}),
    sendKeys: vi.fn(async () => {}),
    checkPaneExists: vi.fn(async () => true),
  };

  const worktreeServiceFactory = { create: vi.fn() };
  const gitProvider = { findPullRequestByBranch: vi.fn(async () => null) };
  const transportFactory = { getTransport: vi.fn() };
  const paneClassifier = {};
  const contentExtractor = { generateSlug: vi.fn(async () => 'slug') };
  const paneStreamFactory = {};

  const windowRepo = {
    add: vi.fn(() => 1),
    findById: vi.fn(),
    findByProject: vi.fn(() => []),
    findByTask: vi.fn(() => []),
    update: vi.fn(),
    updateAgentSessionIdByWindow: vi.fn(),
    remove: vi.fn(),
    removeByServerAndTarget: vi.fn(() => 0),
    updatePaneLayout: vi.fn(),
  };

  const sessionStrategyFactory = { create: vi.fn(() => ({ supportsSession: false })) };
  const sidekickSyncService = { sync: vi.fn(async () => {}) };
  const turnRepo = {
    supersedeRunning: vi.fn(),
    create: vi.fn(),
    findById: vi.fn(() => null),
    findLatestEventByType: vi.fn(() => null),
    markEnded: vi.fn(),
    appendEvent: vi.fn(),
  };
  const turnSignalHub = { emitSignal: vi.fn(), subscribe: vi.fn(() => () => {}) };
  const supervisorRegistry = { isConnected: vi.fn(() => false), sendCommand: vi.fn(async () => {}), clearExitMarker: vi.fn() };
  const projectSecretRepo = { findByProjectWithValues: vi.fn(() => []) };

  const useCase = new ExecuteTaskUseCase(
    taskRepo,
    unitRepo,
    serverRepo,
    projectRepo,
    projectServerRepo,
    sidekickLoader as any,
    logRepo as any,
    tmux as any,
    worktreeServiceFactory as any,
    gitProvider as any,
    transportFactory as any,
    paneClassifier as any,
    contentExtractor as any,
    paneStreamFactory as any,
    windowRepo as any,
    sessionStrategyFactory as any,
    sidekickSyncService as any,
    turnRepo as any,
    turnSignalHub as any,
    supervisorRegistry as any,
    { getOrThrow: vi.fn(() => ({ name: 'devops', label: 'DevOps', description: '', phases: [] })) } as any,
    { check: vi.fn(async () => ({ ok: true, reasons: [], memAvailablePercent: null, loadPerCore: null, memAvailablePercentMin: 10, loadPerCoreMax: 2 })) } as any,
    projectSecretRepo as any,
  );

  return { useCase, taskRepo, windowRepo, logRepo, tmux, supervisorRegistry, worktreeServiceFactory };
}

describe('ExecuteTaskUseCase execution-env resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves the Unit from task.unitId when set', async () => {
    const unit = makeUnit({ id: 42, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ serverName: 'local-server', unitId: 42 });
    const { useCase, windowRepo } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
    });

    await useCase.execute(42, 1);

    expect(windowRepo.add).toHaveBeenCalledWith(expect.objectContaining({ workerType: 'claude', workerModel: 'opus' }));
  });

  it('clears the exit marker before runtime.resume() for a supervised follow-up on a local server', async () => {
    const unit = makeUnit({ id: 49, workerType: 'claude', workerModel: 'opus', workerExecutionMode: 'http-signal' });
    const task = makeTask({ id: 4, serverName: 'local-server', unitId: 49, tmuxWindow: 'task-4' });
    const { useCase, tmux, windowRepo, supervisorRegistry } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
    });
    // followUp reads the window's supervised flag
    (windowRepo.findByTask as ReturnType<typeof vi.fn>).mockReturnValue([
      { id: 10, ownerType: 'task', isPrimary: true, taskId: 4, serverName: 'local-server', tmuxTarget: 'azito:task-4.1', label: 'task-4', projectId: null, windowType: 'agent', workerType: 'claude', workerModel: 'opus', agentSessionId: null, launchCommand: null, workingDirectory: null, paneLayout: null, createdAt: '2026-01-01T00:00:00Z' },
    ]);

    await useCase.followUp(49, 4, 'please continue');

    const launchCall = tmux.sendKeys.mock.calls.find((call: unknown[]) => (call[2] as string[])[0]?.includes('claude'));
    expect(launchCall).toBeDefined();
    const sentCommand = (launchCall as unknown[])[2] as string[];
    // Wrapped (not the bare launch command) — checked via the wrap's own flags rather than a
    // literal supervisor-binary-path substring, since that path is environment-dependent.
    expect(sentCommand[0]).not.toBe("claude --dangerously-skip-permissions --model 'opus'");
    expect(sentCommand[0]).toContain('--task-id 4');
    expect(sentCommand[0]).toContain('--unit-id 49');
    // A leftover exit marker from the previous run on this exact target must not
    // suppress `supervised` while the new supervisor isn't registered yet.
    expect(supervisorRegistry.clearExitMarker).toHaveBeenCalledWith('local-server', 'azito:w1');
  });

  it('wraps the worker launch sendKeys command for an agent window on a local server (http-signal mode)', async () => {
    const unit = makeUnit({ id: 47, workerType: 'claude', workerModel: 'opus', workerExecutionMode: 'http-signal' });
    const task = makeTask({ id: 3, serverName: 'local-server', unitId: 47 });
    const { useCase, tmux } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
    });

    await useCase.execute(47, 3);

    const launchCall = tmux.sendKeys.mock.calls.find((call: unknown[]) => (call[2] as string[])[0]?.includes('claude'));
    expect(launchCall).toBeDefined();
    const sentCommand = (launchCall as unknown[])[2] as string[];
    expect(sentCommand[0]).toContain('tui-supervisor');
    expect(sentCommand[0]).toContain('claude --dangerously-skip-permissions');
    expect(sentCommand[0]).toContain('--task-id 3');
    expect(sentCommand[0]).toContain('--unit-id 47');
  });

  it('wraps the worker launch sendKeys command for an agent window on a local server (tmux-pipe mode)', async () => {
    const unit = makeUnit({ id: 48, workerType: 'claude', workerModel: 'opus', workerExecutionMode: 'tmux-pipe' });
    const task = makeTask({ id: 4, serverName: 'local-server', unitId: 48 });
    const { useCase, tmux } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
    });

    await useCase.execute(48, 4);

    const launchCall = tmux.sendKeys.mock.calls.find((call: unknown[]) => (call[2] as string[])[0]?.includes('claude'));
    expect(launchCall).toBeDefined();
    const sentCommand = (launchCall as unknown[])[2] as string[];
    expect(sentCommand[0]).toContain('tui-supervisor');
    expect(sentCommand[0]).toContain('claude --dangerously-skip-permissions');
    expect(sentCommand[0]).toContain('--task-id 4');
    expect(sentCommand[0]).toContain('--unit-id 48');
  });

  it('does not wrap the worker launch sendKeys command for a terminal window', async () => {
    const unit = makeUnit({ id: 55, workerType: null, workerModel: null, workerExecutionMode: 'tmux-pipe' });
    const task = makeTask({ id: 5, serverName: 'local-server', unitId: 55 });
    const { useCase, tmux } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
    });

    await useCase.execute(55, 5);

    // Terminal windows (workerType: null) have no agent launch command to wrap,
    // and shouldSupervise returns false for windowType 'terminal'.
    const launchCall = tmux.sendKeys.mock.calls.find((call: unknown[]) => {
      const keys = call[2] as string[];
      return keys[0] && !keys[0].includes('tui-supervisor');
    });
    // No supervisor wrapping should occur for terminal windows
    const supervisorCall = tmux.sendKeys.mock.calls.find((call: unknown[]) => {
      const keys = call[2] as string[];
      return keys[0]?.includes('tui-supervisor');
    });
    expect(supervisorCall).toBeUndefined();
  });

  it('resolves the Unit from project.defaultUnitId when task has no override', async () => {
    const unit = makeUnit({ id: 77, workerType: 'codex', workerModel: 'gpt-5-codex' });
    const task = makeTask({ serverName: 'local-server', unitId: null });
    const { useCase, windowRepo } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: 77 }),
      units: [unit],
    });

    await useCase.execute(77, 1);

    expect(windowRepo.add).toHaveBeenCalledWith(expect.objectContaining({ workerType: 'codex', workerModel: 'gpt-5-codex' }));
  });

  it('fails fast (marks task failed, throws) when neither task.serverName nor a project_servers row is available', async () => {
    const task = makeTask({ serverName: null, unitId: 1 });
    const { useCase, taskRepo, windowRepo } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [makeUnit({ id: 1 })],
      projectServer: null,
    });

    await expect(useCase.execute(1, 1)).rejects.toThrow(/Cannot resolve execution server/);
    expect(taskRepo.updateStatus).toHaveBeenCalledWith(1, 'failed');
    expect(windowRepo.add).not.toHaveBeenCalled();
  });

  it('fails fast (ambiguous) when task.serverName is null and the project has multiple project_servers rows', async () => {
    const task = makeTask({ serverName: null, unitId: 1 });
    const { useCase, taskRepo, windowRepo } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [makeUnit({ id: 1 })],
      projectServersList: [
        { projectId: 1, serverName: 'server-a', workingDirectory: null, branch: null, tmuxSession: 'azito' },
        { projectId: 1, serverName: 'server-b', workingDirectory: null, branch: null, tmuxSession: 'azito' },
      ],
    });

    await expect(useCase.execute(1, 1)).rejects.toThrow(/Cannot resolve execution server/);
    expect(taskRepo.updateStatus).toHaveBeenCalledWith(1, 'failed');
    expect(windowRepo.add).not.toHaveBeenCalled();
  });

  it('fails fast (marks task failed, throws) when neither task.unitId nor project.defaultUnitId is set', async () => {
    // A dummy unit (id 999) is present so the initial "unit for this run exists" guard in
    // execute() passes; the task/project itself has no unitId, so resolveExecutionEnv's
    // separate resolveUnitId(task, project) lookup is what's expected to fail here.
    const task = makeTask({ serverName: 'local-server', unitId: null });
    const { useCase, taskRepo, windowRepo } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [makeUnit({ id: 999 })],
    });

    await expect(useCase.execute(999, 1)).rejects.toThrow(/Cannot resolve Unit/);
    expect(taskRepo.updateStatus).toHaveBeenCalledWith(1, 'failed');
    expect(windowRepo.add).not.toHaveBeenCalled();
  });

  it('fails fast on execute when the requested unit id differs from the unit the task resolves to (task.unitId)', async () => {
    const task = makeTask({ serverName: 'local-server', unitId: 42 });
    const { useCase, taskRepo, windowRepo } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [makeUnit({ id: 42 }), makeUnit({ id: 43, name: 'other-unit' })],
    });

    await expect(useCase.execute(43, 1)).rejects.toThrow(/Unit mismatch: request addressed unit 43, but task 1 resolves to unit 42/);
    // A mismatch is a request/task disagreement, not a broken task — status stays untouched.
    expect(taskRepo.updateStatus).not.toHaveBeenCalledWith(1, 'failed');
    expect(windowRepo.add).not.toHaveBeenCalled();
  });

  it('fails fast on execute when the requested unit id differs from the project default the task resolves to', async () => {
    const task = makeTask({ serverName: 'local-server', unitId: null });
    const { useCase, windowRepo } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: 42 }),
      units: [makeUnit({ id: 42 }), makeUnit({ id: 43, name: 'other-unit' })],
    });

    await expect(useCase.execute(43, 1)).rejects.toThrow(/Unit mismatch/);
    expect(windowRepo.add).not.toHaveBeenCalled();
  });

  it('fails fast on followUp when the requested unit id differs from the unit the task resolves to', async () => {
    const task = makeTask({ serverName: 'local-server', unitId: 42 });
    const { useCase } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [makeUnit({ id: 42 }), makeUnit({ id: 43, name: 'other-unit' })],
    });

    await expect(useCase.followUp(43, 1, 'do more')).rejects.toThrow(/Unit mismatch/);
  });

  it('replaces a stale primary window row for this task instead of accumulating rows', async () => {
    // A second execute() run for the same task must not leave the old primary
    // window row behind — that accumulation is what let AgentActivityMonitor
    // mistake long-gone tmux windows for running agents.
    const taskId = 1;
    const unit = makeUnit({ id: 42, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ id: taskId, serverName: 'local-server', unitId: 42 });
    const staleWindow = { id: 5, ownerType: 'task' as const, isPrimary: true, taskId, serverName: 'local-server', tmuxTarget: 'azito:old.1', label: 'old', projectId: null, windowType: 'agent' as const, workerType: 'claude', workerModel: null, agentSessionId: null, launchCommand: null, workingDirectory: null, paneLayout: null, supervised: false, createdAt: '2026-01-01T00:00:00Z' };
    const nonPrimarySibling = { ...staleWindow, id: 6, isPrimary: false };
    const projectOwnedRow = { ...staleWindow, id: 7, ownerType: 'project' as const, isPrimary: true };
    const { useCase, windowRepo } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
    });
    (windowRepo as unknown as { findByTask: (taskId: number) => unknown[] }).findByTask =
      vi.fn(() => [staleWindow, nonPrimarySibling, projectOwnedRow]);

    await useCase.execute(42, taskId);

    expect(windowRepo.findByTask).toHaveBeenCalledWith(taskId);
    expect(windowRepo.remove).toHaveBeenCalledTimes(1);
    expect(windowRepo.remove).toHaveBeenCalledWith(5);
    expect(windowRepo.add).toHaveBeenCalledWith(expect.objectContaining({ workerType: 'claude', workerModel: 'opus' }));
  });

  it('fails fast on resumeStateMachine when the requested unit id differs from the unit the task resolves to', async () => {
    const task = makeTask({ serverName: 'local-server', unitId: 42 });
    const { useCase } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [makeUnit({ id: 42 }), makeUnit({ id: 43, name: 'other-unit' })],
    });

    await expect(useCase.resumeStateMachine(43, 1)).rejects.toThrow(/Unit mismatch/);
  });
});

describe('ExecuteTaskUseCase.followUp http-signal execution mode (Issue: AZITO監視強化 Phase 1)', () => {
  it('creates a follow_up turn (kind, phase:null) via the real HttpSignalTurnCoordinator, sends the http-signal envelope (not the tmux marker echo), and reconciles the turn as aborted when the run is stopped', async () => {
    const unit = makeUnit({ id: 42, workerExecutionMode: 'http-signal' });
    const task = makeTask({ id: 1, serverName: 'local-server', unitId: 42, tmuxWindow: 'task-1', status: 'open' });

    const taskRepo: ITaskRepository = {
      findAll: vi.fn(() => []),
      findByProject: vi.fn(() => []),
      findByUnit: vi.fn(() => []),
      findByStatus: vi.fn(() => []),
      findAgentSessionIdsByServer: vi.fn(() => new Set<string>()),
      findById: vi.fn(() => task),
      create: vi.fn(() => 1),
      update: vi.fn(),
      updateStatus: vi.fn(),
      updateCurrentPhase: vi.fn(),
      touch: vi.fn(),
      delete: vi.fn(),
    };
    const unitRepo: IUnitRepository = {
      findAll: vi.fn(() => [unit]),
      findById: vi.fn(() => unit),
      create: vi.fn(() => 1),
      update: vi.fn(),
      delete: vi.fn(),
    };
    const serverRepo: IServerRepository = {
      findAll: vi.fn(() => [makeServer()]),
      findByName: vi.fn(() => makeServer()),
      create: vi.fn(),
      update: vi.fn(),
      updateAgentVersion: vi.fn(),
      updateFingerprint: vi.fn(),
      clearFingerprint: vi.fn(),
      delete: vi.fn(),
    };
    const project = makeProject({ defaultUnitId: null });
    const projectRepo: IProjectRepository = {
      findAll: vi.fn(() => []),
      findById: vi.fn(() => project),
      create: vi.fn(() => 1),
      update: vi.fn(),
      delete: vi.fn(),
      addRepository: vi.fn(() => 1),
      findRepositoryById: vi.fn(() => null),
      removeRepository: vi.fn(),
    };
    const projectServerRepo: IProjectServerRepository = {
      findByProject: vi.fn(() => [{ projectId: 1, serverName: 'local-server', workingDirectory: '/work', branch: null, tmuxSession: 'azito' }]),
      findByServer: vi.fn(() => []),
      find: vi.fn(() => ({ projectId: 1, serverName: 'local-server', workingDirectory: '/work', branch: null, tmuxSession: 'azito' })),
      upsert: vi.fn(),
      remove: vi.fn(),
    };
    const sidekickLoader = { list: vi.fn(() => []), findByName: vi.fn(() => null), findDefaultForPhase: vi.fn(), invalidateCache: vi.fn() };
    const logRepo = { append: vi.fn(), findByTask: vi.fn(() => []), findByUnit: vi.fn(() => []) };
    // windowExists=true (tmux.listSessions returns the task's window already
    // present) so followUp skips the create-window/launch-worker branch and
    // goes straight to sending the follow-up prompt + waiting.
    const tmux = {
      listSessions: vi.fn(async () => [{ name: 'azito', windows: [{ name: 'task-1', index: 1 }] }]),
      createSession: vi.fn(async () => {}),
      createWindow: vi.fn(async () => ({ windowName: 'task-1' })),
      resolvePaneId: vi.fn(async () => '%0'),
      killPane: vi.fn(async () => {}),
      killWindow: vi.fn(async () => {}),
      sendKeys: vi.fn(async (_server: unknown, _target: string, _keys: string[]) => {}),
      startPipePane: vi.fn(async () => {}),
      stopPipePane: vi.fn(async () => {}),
      getWindowActivity: vi.fn(async () => null),
      capturePane: vi.fn(async () => ({ stdout: '' })),
      execCommand: vi.fn(async () => ({ stdout: '' })),
    };
    const worktreeServiceFactory = { create: vi.fn(() => ({ exists: vi.fn(async () => false) })) };
    const gitProvider = { findPullRequestByBranch: vi.fn(async () => null) };
    const transportFactory = { getTransport: vi.fn() };
    const paneClassifier = { classify: vi.fn(async () => ({ status: 'still_working' })) };
    const contentExtractor = { generateSlug: vi.fn(async () => 'slug'), extractPlan: vi.fn(async () => ({ planMarkdown: null })) };
    const paneStreamFactory = {
      create: vi.fn(() => ({
        start: vi.fn(),
        stop: vi.fn(),
        on: vi.fn(),
        getBuffer: () => '',
        getFilePath: () => '/tmp/pipe',
        setMarkers: vi.fn(),
        enableMarkerDetection: vi.fn(),
      })),
    };
    const windowRepo = {
      add: vi.fn(() => 1),
      findById: vi.fn(),
      findByProject: vi.fn(() => []),
      findByTask: vi.fn(() => []),
      update: vi.fn(),
      remove: vi.fn(),
      removeByServerAndTarget: vi.fn(() => 0),
      updatePaneLayout: vi.fn(),
    };
    const sessionStrategyFactory = { create: vi.fn(() => ({ supportsSession: false })) };
    const sidekickSyncService = { sync: vi.fn(async () => {}) };
    const turnRepo = new FakeAgentTurnRepo();
    const turnSignalHub = new TurnSignalHub();
    const supervisorRegistry = { isConnected: vi.fn(() => false), sendCommand: vi.fn(async () => {}), clearExitMarker: vi.fn() };
    const projectSecretRepo = { findByProjectWithValues: vi.fn(() => []) };

    const useCase = new ExecuteTaskUseCase(
      taskRepo,
      unitRepo,
      serverRepo,
      projectRepo,
      projectServerRepo,
      sidekickLoader as any,
      logRepo as any,
      tmux as any,
      worktreeServiceFactory as any,
      gitProvider as any,
      transportFactory as any,
      paneClassifier as any,
      contentExtractor as any,
      paneStreamFactory as any,
      windowRepo as any,
      sessionStrategyFactory as any,
      sidekickSyncService as any,
      turnRepo as any,
      turnSignalHub as any,
      supervisorRegistry as any,
      { getOrThrow: vi.fn(() => ({ name: 'devops', label: 'DevOps', description: '', phases: [] })) } as any,
      { check: vi.fn(async () => ({ ok: true, reasons: [], memAvailablePercent: null, loadPerCore: null, memAvailablePercentMin: 10, loadPerCoreMax: 2 })) } as any,
      projectSecretRepo as any,
    );

    await useCase.followUp(42, 1, 'please continue');

    // Flush the fire-and-forget runFollowUp() chain up through waitForWorker
    // registering its abort listener — every intervening step (tmux mocks,
    // HttpSignalTurnCoordinator.start) resolves on microtasks, no real
    // timers are involved before this point.
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(turnRepo.turns).toHaveLength(1);
    expect(turnRepo.turns[0]).toMatchObject({ taskId: 1, unitId: 42, kind: 'follow_up', phase: null, status: 'running' });

    const sentPrompt = tmux.sendKeys.mock.calls.find(
      (c) => typeof c[2]?.[0] === 'string' && (c[2][0] as string).includes('completion_signal'),
    )?.[2]?.[0] as string | undefined;
    expect(sentPrompt).toBeDefined();
    expect(sentPrompt).toContain('azitoctl complete --turn');
    expect(sentPrompt).not.toContain('echo "AZITO_DONE_'); // not the tmux-pipe marker mechanism

    // Abort to unblock the wait deterministically (bypasses the quiescence wait).
    const stopped = useCase.stopByTaskId(1);
    expect(stopped).toBe(true);
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(turnRepo.turns[0].status).toBe('aborted');
    expect(turnRepo.turns[0].completionSource).toBe('abort');
    expect(taskRepo.updateStatus).toHaveBeenCalledWith(1, 'review');
  });
});

describe('ExecuteTaskUseCase working-directory containment (Issue #27)', () => {
  let allowedRoot: string;
  let outsideDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    allowedRoot = mkdtempSync(path.join(tmpdir(), 'azito-exec-root-'));
    outsideDir = mkdtempSync(path.join(tmpdir(), 'azito-exec-outside-'));
  });

  afterEach(() => {
    rmSync(allowedRoot, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('rejects a task.workingDirectory that escapes the project working directory via ..', async () => {
    const unit = makeUnit({ id: 10, workerType: 'claude', workerModel: 'opus' });
    const escaped = path.join(allowedRoot, '..', path.basename(outsideDir));
    const task = makeTask({ id: 1, serverName: 'local-server', unitId: 10, workingDirectory: escaped });
    const { useCase, taskRepo, windowRepo, logRepo, worktreeServiceFactory } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
      projectServer: { workingDirectory: allowedRoot, branch: null, tmuxSession: 'azito' },
    });
    const worktreeCreate = vi.fn();
    worktreeServiceFactory.create.mockReturnValue({ create: worktreeCreate });

    await expect(useCase.execute(10, 1)).rejects.toThrow(/Task working directory rejected/);

    expect(worktreeCreate).not.toHaveBeenCalled();
    expect(taskRepo.update).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'failed' }));
    expect(windowRepo.add).not.toHaveBeenCalled();
    expect(logRepo.append).toHaveBeenCalledWith(1, 10, 'command', expect.objectContaining({ type: 'working_directory_rejected' }));
  });

  it('rejects a task.workingDirectory that is an unrelated absolute path outside the project working directory', async () => {
    const unit = makeUnit({ id: 11, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ id: 2, serverName: 'local-server', unitId: 11, workingDirectory: outsideDir });
    const { useCase, taskRepo, windowRepo, worktreeServiceFactory } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
      projectServer: { workingDirectory: allowedRoot, branch: null, tmuxSession: 'azito' },
    });
    const worktreeCreate = vi.fn();
    worktreeServiceFactory.create.mockReturnValue({ create: worktreeCreate });

    await expect(useCase.execute(11, 2)).rejects.toThrow(/Task working directory rejected/);
    expect(worktreeCreate).not.toHaveBeenCalled();
    expect(taskRepo.update).toHaveBeenCalledWith(2, expect.objectContaining({ status: 'failed' }));
    expect(windowRepo.add).not.toHaveBeenCalled();
  });

  it('allows a task.workingDirectory nested inside the project working directory', async () => {
    const unit = makeUnit({ id: 12, workerType: 'claude', workerModel: 'opus' });
    const nested = path.join(allowedRoot, 'nested');
    mkdirSync(nested);
    const task = makeTask({ id: 3, serverName: 'local-server', unitId: 12, workingDirectory: nested });
    const { useCase, windowRepo, worktreeServiceFactory } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
      projectServer: { workingDirectory: allowedRoot, branch: null, tmuxSession: 'azito' },
    });
    const worktreePath = path.join(nested, '.worktrees', 'task-3');
    mkdirSync(worktreePath, { recursive: true });
    worktreeServiceFactory.create.mockReturnValue({
      create: vi.fn(async () => ({ path: worktreePath, branch: 'task/3-slug' })),
    });

    await useCase.execute(12, 3);

    expect(windowRepo.add).toHaveBeenCalledWith(expect.objectContaining({ workerType: 'claude', workerModel: 'opus' }));
  });

  it('rejects (fail closed) a resolved worktree path containing shell metacharacters instead of quoting it through to the cd command (Issue #27: assertPathContained now runs assertSafePath on the resolved worktree path, since downstream shell interpolation elsewhere — e.g. PushVerifier — is not quoted and depends on this invariant)', async () => {
    // A directory name with shell metacharacters is legal on disk. Rather
    // than let the resolved (real) worktree path reach the pane as a quoted
    // `cd` argument, it must be rejected up front — a persisted
    // `task.worktreePath` in this format would later reach unquoted shell
    // interpolation in `PushVerifier`.
    const unit = makeUnit({ id: 16, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ id: 9, serverName: 'local-server', unitId: 16 });
    const { useCase, tmux, taskRepo, windowRepo, worktreeServiceFactory } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
      projectServer: { workingDirectory: allowedRoot, branch: null, tmuxSession: 'azito' },
    });
    const dangerousDir = path.join(allowedRoot, `evil; touch pwned; echo $(whoami)'q`);
    mkdirSync(dangerousDir);
    worktreeServiceFactory.create.mockReturnValue({
      create: vi.fn(async () => ({ path: dangerousDir, branch: 'task/9-slug' })),
    });

    await expect(useCase.execute(16, 9)).rejects.toThrow(/not in a safe path format/);

    expect(taskRepo.update).toHaveBeenCalledWith(9, expect.objectContaining({ status: 'failed' }));
    expect(windowRepo.add).not.toHaveBeenCalled();
    const cdCall = tmux.sendKeys.mock.calls.find((call: unknown[]) => ((call as unknown[])[2] as string[])[0]?.startsWith('cd '));
    expect(cdCall).toBeUndefined();
  });

  it('rejects when the created worktree path resolves outside the project working directory (symlink escape)', async () => {
    const unit = makeUnit({ id: 13, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ id: 4, serverName: 'local-server', unitId: 13 });
    const { useCase, taskRepo, windowRepo, logRepo, worktreeServiceFactory } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
      projectServer: { workingDirectory: allowedRoot, branch: null, tmuxSession: 'azito' },
    });
    // Simulate a worktree service that reports a path escaping allowedRoot —
    // exercises the post-creation wt.path containment check independently of
    // how the escape happened (symlink, bug in the worktree service, etc).
    worktreeServiceFactory.create.mockReturnValue({
      create: vi.fn(async () => ({ path: outsideDir, branch: 'task/4-slug' })),
    });

    await expect(useCase.execute(13, 4)).rejects.toThrow(/Worktree path rejected/);

    expect(taskRepo.update).toHaveBeenCalledWith(4, expect.objectContaining({ status: 'failed' }));
    expect(windowRepo.add).not.toHaveBeenCalled();
    expect(logRepo.append).toHaveBeenCalledWith(4, 13, 'command', expect.objectContaining({ type: 'worktree_path_rejected' }));
  });

  it('skips containment checks when the project has no configured working directory (legacy behavior preserved)', async () => {
    const unit = makeUnit({ id: 14, workerType: 'claude', workerModel: 'opus' });
    const escaped = path.join(allowedRoot, '..', path.basename(outsideDir));
    const task = makeTask({ id: 5, serverName: 'local-server', unitId: 14, workingDirectory: escaped });
    const { useCase, windowRepo, worktreeServiceFactory } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
      projectServer: null,
    });
    worktreeServiceFactory.create.mockReturnValue({
      create: vi.fn(async () => ({ path: escaped, branch: 'task/5-slug' })),
    });

    await useCase.execute(14, 5);

    // No allowedRoot (projectServer.workingDirectory unset) — containment is
    // skipped, so execution proceeds as before this change.
    expect(windowRepo.add).toHaveBeenCalledWith(expect.objectContaining({ workerType: 'claude', workerModel: 'opus' }));
  });

  it('cleans up the worktree (removes it, clears worktreePath/worktreeBranch) when the post-creation containment check rejects it', async () => {
    const unit = makeUnit({ id: 15, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ id: 6, serverName: 'local-server', unitId: 15 });
    const { useCase, taskRepo, windowRepo, worktreeServiceFactory } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
      projectServer: { workingDirectory: allowedRoot, branch: null, tmuxSession: 'azito' },
    });
    const worktreeRemove = vi.fn(async () => {});
    worktreeServiceFactory.create.mockReturnValue({
      create: vi.fn(async () => ({ path: outsideDir, branch: 'task/6-slug' })),
      remove: worktreeRemove,
    });

    await expect(useCase.execute(15, 6)).rejects.toThrow(/Worktree path rejected/);

    expect(worktreeRemove).toHaveBeenCalledWith(allowedRoot, outsideDir);
    expect(taskRepo.update).toHaveBeenCalledWith(6, expect.objectContaining({
      status: 'failed',
      worktreePath: null,
      worktreeBranch: null,
    }));
    expect(windowRepo.add).not.toHaveBeenCalled();
  });
});

describe('ExecuteTaskUseCase.followUp working-directory containment (Issue #27 review finding 1)', () => {
  let allowedRoot: string;
  let outsideDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    allowedRoot = mkdtempSync(path.join(tmpdir(), 'azito-followup-root-'));
    outsideDir = mkdtempSync(path.join(tmpdir(), 'azito-followup-outside-'));
  });

  afterEach(() => {
    rmSync(allowedRoot, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('rejects a task.workingDirectory that escapes the project working directory (no tmux window exists yet)', async () => {
    const unit = makeUnit({ id: 20, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ id: 7, serverName: 'local-server', unitId: 20, tmuxWindow: null, workingDirectory: outsideDir });
    const { useCase, taskRepo, worktreeServiceFactory } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
      projectServer: { workingDirectory: allowedRoot, branch: null, tmuxSession: 'azito' },
    });
    worktreeServiceFactory.create.mockReturnValue({ exists: vi.fn(async () => false) });

    await expect(useCase.followUp(20, 7, 'please continue')).rejects.toThrow(/Follow-up working directory rejected/);

    expect(taskRepo.update).toHaveBeenCalledWith(7, expect.objectContaining({ status: 'failed' }));
  });

  it('rejects a persisted task.worktreePath that exists on disk but resolves outside the project working directory (regression: existence was previously treated as trust)', async () => {
    const unit = makeUnit({ id: 21, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ id: 8, serverName: 'local-server', unitId: 21, tmuxWindow: null, worktreePath: outsideDir });
    const { useCase, taskRepo, worktreeServiceFactory } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
      projectServer: { workingDirectory: allowedRoot, branch: null, tmuxSession: 'azito' },
    });
    // The worktree "exists" on disk (persisted path is real) — the point of
    // this test is that existence alone must not be trusted as containment.
    worktreeServiceFactory.create.mockReturnValue({ exists: vi.fn(async () => true) });

    await expect(useCase.followUp(21, 8, 'please continue')).rejects.toThrow(/Follow-up working directory rejected/);

    expect(taskRepo.update).toHaveBeenCalledWith(8, expect.objectContaining({ status: 'failed' }));
  });

  it('allows a task.workingDirectory nested inside the project working directory', async () => {
    const unit = makeUnit({ id: 22, workerType: 'claude', workerModel: 'opus' });
    const nested = path.join(allowedRoot, 'nested-followup');
    mkdirSync(nested);
    const task = makeTask({ id: 9, serverName: 'local-server', unitId: 22, tmuxWindow: null, workingDirectory: nested });
    const { useCase, taskRepo, worktreeServiceFactory } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
      projectServer: { workingDirectory: allowedRoot, branch: null, tmuxSession: 'azito' },
    });
    worktreeServiceFactory.create.mockReturnValue({ exists: vi.fn(async () => false) });

    await useCase.followUp(22, 9, 'please continue');

    // Containment passed — the run reaches the normal in_progress transition
    // rather than being short-circuited into 'failed'.
    expect(taskRepo.updateStatus).toHaveBeenCalledWith(9, 'in_progress');
    expect(taskRepo.update).not.toHaveBeenCalledWith(9, expect.objectContaining({ status: 'failed' }));
  });
});

describe('ExecuteTaskUseCase stale window cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeWindowRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 100, ownerType: 'task', projectId: null, taskId: 1,
      serverName: 'local-server', tmuxTarget: 'azito:w1.1',
      label: 'w1', isPrimary: false, windowType: 'agent',
      workerType: 'claude', workerModel: 'opus', agentSessionId: null,
      launchCommand: null, workingDirectory: null, paneLayout: null,
      createdAt: '2026-01-01T00:00:00Z',
      ...overrides,
    };
  }

  it('removes task-owned non-primary rows whose tmux pane no longer exists', async () => {
    const unit = makeUnit({ id: 10, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ serverName: 'local-server', unitId: 10 });
    const { useCase, windowRepo, tmux } = buildUseCase({
      task, project: makeProject(), units: [unit],
    });

    const deadRow = makeWindowRow({ id: 101, tmuxTarget: 'azito:dead.1', isPrimary: false });
    const aliveRow = makeWindowRow({ id: 102, tmuxTarget: 'azito:alive.1', isPrimary: false });
    (windowRepo.findByTask as ReturnType<typeof vi.fn>).mockReturnValue([deadRow, aliveRow]);
    (tmux.checkPaneExists as ReturnType<typeof vi.fn>).mockImplementation(async (_server: unknown, target: string) => {
      return target === 'azito:alive.1';
    });

    await useCase.execute(10, 1);

    expect(windowRepo.remove).toHaveBeenCalledWith(101);
    expect(windowRepo.remove).not.toHaveBeenCalledWith(102);
  });

  it('keeps rows when checkPaneExists throws', async () => {
    const unit = makeUnit({ id: 10, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ serverName: 'local-server', unitId: 10 });
    const { useCase, windowRepo, tmux } = buildUseCase({
      task, project: makeProject(), units: [unit],
    });

    const errorRow = makeWindowRow({ id: 103, tmuxTarget: 'azito:err.1', isPrimary: false });
    (windowRepo.findByTask as ReturnType<typeof vi.fn>).mockReturnValue([errorRow]);
    (tmux.checkPaneExists as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('tmux not responding'));

    await useCase.execute(10, 1);

    expect(windowRepo.remove).not.toHaveBeenCalledWith(103);
  });

  it('always removes primary rows regardless of pane existence', async () => {
    const unit = makeUnit({ id: 10, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ serverName: 'local-server', unitId: 10 });
    const { useCase, windowRepo, tmux } = buildUseCase({
      task, project: makeProject(), units: [unit],
    });

    const primaryRow = makeWindowRow({ id: 104, isPrimary: true });
    (windowRepo.findByTask as ReturnType<typeof vi.fn>).mockReturnValue([primaryRow]);

    await useCase.execute(10, 1);

    expect(windowRepo.remove).toHaveBeenCalledWith(104);
    expect(tmux.checkPaneExists).not.toHaveBeenCalled();
  });
});
