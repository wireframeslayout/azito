import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { ExecuteTaskUseCase } from './ExecuteTaskUseCase';
import { shellQuote } from '../../../shared/shellQuote';
import { KeyedMutex } from '../../../shared/keyedMutex';
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
    inputTrust: 'trusted',
    executionApprovedFingerprintHash: null,
    pendingOperation: null,
    pendingOperationWindowId: null,
    pendingOperationPriorStatus: null,
    createdByKind: 'operator',
    createdById: null,
    createdViaGeneration: null,
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
    isolationIntent: false,
    isolationVerifiedAt: null,
    isolationReport: null,
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
  projectServer?: { workingDirectory: string | null; branch: string | null; tmuxSession: string; inputPolicy?: 'deny' | 'manual-approval' | 'allow' } | null;
  /** When set, overrides findByProject entirely (e.g. to simulate multiple project servers). */
  projectServersList?: Array<{ projectId: number; serverName: string; workingDirectory: string | null; branch: string | null; tmuxSession: string; inputPolicy?: 'deny' | 'manual-approval' | 'allow' }>;
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
    consumePendingApproval: vi.fn(() => false),
    // Mirrors SqliteTaskRepository's guard: only succeeds while no block is
    // already outstanding (opts.task is the same object reference `findById`
    // above always returns, so mutating it here is visible to the next call —
    // same trick this file's other tests already use, e.g. setting
    // `task.executionApprovedFingerprintHash` directly before calling execute()).
    recordExecutionGateBlock: vi.fn((_id: number, fields: { pendingOperation: string; priorStatus: string }) => {
      if (opts.task.pendingOperation !== null) return false;
      opts.task.status = 'pending_approval' as Task['status'];
      opts.task.pendingOperation = fields.pendingOperation as Task['pendingOperation'];
      opts.task.pendingOperationPriorStatus = fields.priorStatus as Task['pendingOperationPriorStatus'];
      return true;
    }),
    preApproveExecution: vi.fn(() => true),
    countChildren: vi.fn(() => 0),
    countChildrenInGeneration: vi.fn(() => 0),
    // Fix 3 (Issue #28 third-party review): mirrors SqliteTaskRepository's
    // guarded UPDATE — only "clears" (here: nulls opts.task.tmuxWindow,
    // findById always returns the same object reference) when the current
    // tmuxWindow still matches the caller's own generation's window name.
    clearTmuxWindowIfMatches: vi.fn((_id: number, expectedWindowName: string) => {
      if (opts.task.tmuxWindow !== expectedWindowName) return false;
      opts.task.tmuxWindow = null;
      return true;
    }),
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
    updateIsolationIntent: vi.fn(),
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
    findByProject: vi.fn(() => (opts.projectServersList ?? (opts.projectServer ? [{ projectId: 1, serverName: 'local-server', ...opts.projectServer }] : [])).map((ps) => ({ inputPolicy: 'manual-approval' as const, ...ps }))),
    findByServer: vi.fn(() => []),
    find: vi.fn(() => (opts.projectServer ? { projectId: 1, serverName: 'local-server', inputPolicy: 'manual-approval' as const, ...opts.projectServer } : null)),
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
    listSessions: vi.fn(async (): Promise<{ name: string; windows: { name: string; index: number }[] }[]> => []),
    createSession: vi.fn(async () => {}),
    createWindow: vi.fn(async () => ({ result: { stdout: '', stderr: '', code: 0 }, windowName: 'w1' })),
    resolvePaneId: vi.fn(async () => '%0'),
    killPane: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
    killWindow: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
    sendKeys: vi.fn(async () => {}),
    checkPaneExists: vi.fn(async () => true),
    uiTokenEnvForServer: vi.fn(() => ({})),
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
  const supervisorRegistry = { isConnected: vi.fn(() => false), isBoundConnected: vi.fn(() => false), sendCommand: vi.fn(async () => {}), clearExitMarker: vi.fn(), issueLaunch: vi.fn(() => undefined) };
  const projectSecretRepo = { findByProjectWithValues: vi.fn(() => []), findByProject: vi.fn(() => []) };
  // Only `get` matters for resolveExecutionManifest()'s `sidekick` field
  // resolution (Issue #328 sixth-round review); returning a UnitType with no
  // phases means that resolution finds no enabled phase and the field stays
  // null, without needing a real phases/tags fixture for these env-resolution
  // tests.
  const unitTypeLoader = {
    get: vi.fn(() => ({ name: 'devops', label: 'DevOps', description: '', phases: [] })),
    getOrThrow: vi.fn(() => ({ name: 'devops', label: 'DevOps', description: '', phases: [] })),
  };
  // Stands in for TaskPaneEnvironmentService — this file's tests assert on
  // tmux.createWindow call sequencing/branching, not on the exact env
  // contents (see TaskPaneEnvironmentService.test.ts for those).
  const paneEnvService = {
    buildEnvForNewWindow: vi.fn(() => ({
      env: { AZITO_TASK_TOKEN: 'azt.task.1.' + 'a'.repeat(64), AZITO_TASK_ID: '1' },
      tokenId: 101,
    })),
    // Issue #28 third-party review fix: the worktree/working-directory
    // rollback branches call this after successfully killing the
    // just-created window — several tests below exercise those branches.
    // Scoped to the specific generation (`tokenId`, mocked as 101 above),
    // not the whole task, per the WindowRotation.ts revokeGeneration fix.
    revokeGeneration: vi.fn(),
    revokeForDestroyedWindow: vi.fn(),
  };

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
    unitTypeLoader as any,
    { check: vi.fn(async () => ({ ok: true, reasons: [], memAvailablePercent: null, loadPerCore: null, memAvailablePercentMin: 10, loadPerCoreMax: 2 })) } as any,
    projectSecretRepo as any,
    new EventEmitter(),
    paneEnvService as any,
    new KeyedMutex(),
  );

  return { useCase, taskRepo, windowRepo, logRepo, tmux, supervisorRegistry, worktreeServiceFactory, unitRepo, projectRepo, projectServerRepo, serverRepo, projectSecretRepo, unitTypeLoader, sidekickLoader, paneEnvService };
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

// Issue #28 third-party review finding (Important, TOCTOU): the confirm-kill
// -> rotate-token -> create -> persist span inside runExclusiveForTask used
// to read task/tmux window state captured BEFORE the lock was even queued
// for. Two execute() calls racing for the same task could both compute
// "the old window to kill" from the SAME pre-lock snapshot; the second call
// (running after the first has already created and persisted its own
// generation) would then decide there is nothing to kill, create ANOTHER
// window, and — via issueNextGeneration()'s revoke-everything-else contract
// — revoke the first call's still-live generation without ever having killed
// its window. That orphans the first call's pane with a dead token. The fix
// re-reads task state from the repository INSIDE the lock callback, so each
// queued rotation always acts on whatever the immediately-prior rotation
// actually persisted.
describe('ExecuteTaskUseCase concurrent execute() serialization (Issue #28 review: TOCTOU inside the per-task lock)', () => {
  it('two concurrent execute() calls for the same task converge to exactly one live tmux window with exactly one valid (non-revoked) token generation', async () => {
    vi.useFakeTimers();
    try {
      const unit = makeUnit({ id: 42, workerType: 'claude', workerModel: 'opus' });
      const task = makeTask({ id: 1, serverName: 'local-server', unitId: 42, tmuxWindow: null });

      // Canonical "DB row" separate from any single call's snapshot of it —
      // this is what actually distinguishes the bug from the fix. Both
      // concurrent execute() calls fetch their OWN task snapshot via
      // taskRepo.findById() at the top of execute() (a fresh copy, exactly
      // like a real SQLite row read); only the code path re-reading via
      // taskRepo.findById() INSIDE the lock (the fix under test) observes
      // the other call's persisted tmuxWindow. Without that re-read, each
      // call would keep using its OWN stale top-of-execute() snapshot for
      // the entire confirm-kill decision, which is exactly the TOCTOU this
      // test guards against.
      let dbTask: Task = { ...task };

      // Shared fake tmux window store — both concurrent execute() calls read
      // and write the SAME store, so a call's re-read inside the lock sees
      // whatever the previously-queued call actually persisted.
      let windows: { name: string; index: number }[] = [];
      let windowCounter = 0;
      let tokenCounter = 0;
      const liveTokens = new Set<number>();

      const { useCase, taskRepo, tmux, paneEnvService } = buildUseCase({
        task,
        project: makeProject({ defaultUnitId: null }),
        units: [unit],
        projectServer: { workingDirectory: null, branch: null, tmuxSession: 'azito' },
      });

      (taskRepo.findById as ReturnType<typeof vi.fn>).mockImplementation(() => ({ ...dbTask }));
      (taskRepo.update as ReturnType<typeof vi.fn>).mockImplementation((_id: number, updates: Partial<Task>) => {
        dbTask = { ...dbTask, ...updates };
      });

      (tmux.listSessions as ReturnType<typeof vi.fn>).mockImplementation(async () => [{ name: 'azito', windows: [...windows] }]);
      (tmux.createSession as ReturnType<typeof vi.fn>).mockImplementation(async () => {});
      (tmux.createWindow as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        const name = `w${++windowCounter}`;
        windows.push({ name, index: windows.length });
        return { result: { stdout: '', stderr: '', code: 0 }, windowName: name };
      });
      // confirmOldWindowGone (execute()'s old-window kill) addresses the
      // target as `${tmuxSession}:${oldWin.index}` (tmux index-based), while
      // rollbackWindowReference's kills address it as
      // `${tmuxSession}:${windowName}` (name-based) — this mock matches
      // either form against the shared window store, same as real tmux would
      // resolve either addressing scheme to the same window.
      (tmux.killWindow as ReturnType<typeof vi.fn>).mockImplementation(async (_server: unknown, target: string) => {
        const seg = (target as string).split(':')[1];
        windows = windows.filter((w) => w.name !== seg && String(w.index) !== seg);
        return { stdout: '', stderr: '', code: 0 };
      });

      (paneEnvService.buildEnvForNewWindow as ReturnType<typeof vi.fn>).mockImplementation(() => {
        // Mirrors the real ITaskTokenRepository.issueNextGeneration contract
        // (see TaskPaneEnvironmentService's doc comment): issuing a new
        // generation revokes every other outstanding generation for the
        // task, so at most one is ever live.
        liveTokens.clear();
        const tokenId = ++tokenCounter;
        liveTokens.add(tokenId);
        return { env: { AZITO_TASK_TOKEN: `t${tokenId}`, AZITO_TASK_ID: '1' }, tokenId };
      });
      (paneEnvService.revokeGeneration as ReturnType<typeof vi.fn>).mockImplementation((tokenId: number) => {
        liveTokens.delete(tokenId);
      });

      const runA = useCase.execute(42, 1);
      const runB = useCase.execute(42, 1);
      await vi.runAllTimersAsync();
      await Promise.all([runA, runB]);

      // Exactly one tmux window survives — the other was either never
      // created without its predecessor being killed first, or was killed as
      // part of the later rotation's confirm-kill step.
      expect(windows).toHaveLength(1);
      // The task's persisted tmuxWindow points at that same surviving window
      // — never a stale reference to a window that was actually killed.
      expect(dbTask.tmuxWindow).toBe(windows[0].name);
      // Exactly one token generation is left live (the real
      // ITaskTokenRepository.issueNextGeneration always enforces this by
      // revoking every prior generation as part of issuing a new one — see
      // this mock's buildEnvForNewWindow above). What the TOCTOU bug this
      // test guards against actually breaks is NOT this invariant, but the
      // window/token pairing above: without the fix, the surviving window
      // can be the ORPHANED one — created by the call whose own generation
      // then got revoked by the other call's rotation — while `windows`
      // ends up with more than one live entry because neither call's kill
      // targeted the window the other actually created.
      expect(liveTokens.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Same TOCTOU shape as execute() above, but for followUp(): the old code
  // computed `windowExists` from a task/tmux snapshot taken BEFORE
  // runExclusiveForTask was even entered. Two concurrent follow-ups for the
  // same not-yet-running task could both observe "no window yet" from their
  // own pre-lock snapshot, both enter the rotation, and the second's
  // issueNextGeneration() would revoke the first's still-being-created
  // generation. The fix moves the ENTIRE read-decide-act sequence
  // (`taskRepo.findById` + the tmux existence check) inside the lock.
  it('two concurrent followUp() calls for a task with no window yet converge to exactly one live tmux window with exactly one valid generation', async () => {
    vi.useFakeTimers();
    try {
      const unit = makeUnit({ id: 42, workerType: 'claude', workerModel: 'opus' });
      const task = makeTask({ id: 1, serverName: 'local-server', unitId: 42, tmuxWindow: null });
      let dbTask: Task = { ...task };

      let windows: { name: string; index: number }[] = [];
      let windowCounter = 0;
      let tokenCounter = 0;
      const liveTokens = new Set<number>();

      const { useCase, taskRepo, tmux, paneEnvService } = buildUseCase({
        task,
        project: makeProject({ defaultUnitId: null }),
        units: [unit],
        projectServer: { workingDirectory: null, branch: null, tmuxSession: 'azito' },
      });

      (taskRepo.findById as ReturnType<typeof vi.fn>).mockImplementation(() => ({ ...dbTask }));
      (taskRepo.update as ReturnType<typeof vi.fn>).mockImplementation((_id: number, updates: Partial<Task>) => {
        dbTask = { ...dbTask, ...updates };
      });

      (tmux.listSessions as ReturnType<typeof vi.fn>).mockImplementation(async () => [{ name: 'azito', windows: [...windows] }]);
      (tmux.createSession as ReturnType<typeof vi.fn>).mockImplementation(async () => {});
      (tmux.createWindow as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        const name = `w${++windowCounter}`;
        windows.push({ name, index: windows.length });
        return { result: { stdout: '', stderr: '', code: 0 }, windowName: name };
      });
      (tmux.killWindow as ReturnType<typeof vi.fn>).mockImplementation(async (_server: unknown, target: string) => {
        const seg = (target as string).split(':')[1];
        windows = windows.filter((w) => w.name !== seg && String(w.index) !== seg);
        return { stdout: '', stderr: '', code: 0 };
      });

      (paneEnvService.buildEnvForNewWindow as ReturnType<typeof vi.fn>).mockImplementation(() => {
        liveTokens.clear();
        const tokenId = ++tokenCounter;
        liveTokens.add(tokenId);
        return { env: { AZITO_TASK_TOKEN: `t${tokenId}`, AZITO_TASK_ID: '1' }, tokenId };
      });
      (paneEnvService.revokeGeneration as ReturnType<typeof vi.fn>).mockImplementation((tokenId: number) => {
        liveTokens.delete(tokenId);
      });

      const runA = useCase.followUp(42, 1, 'go');
      const runB = useCase.followUp(42, 1, 'go');
      await vi.runAllTimersAsync();
      await Promise.all([runA, runB]);

      // followUp() never kills a pre-existing window (design v3 §2: it only
      // rotates when NO window exists yet) — so unlike execute(), a correct
      // outcome here is that the SECOND queued follow-up recognizes the
      // window the first one just created and reuses it, rather than both
      // creating their own.
      expect(windows).toHaveLength(1);
      expect(dbTask.tmuxWindow).toBe(windows[0].name);
      expect(liveTokens.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ExecuteTaskUseCase execution gate (Issue #328)', () => {
  const gateProjectServer = { workingDirectory: null, branch: null, tmuxSession: 'azito', inputPolicy: 'manual-approval' as const };

  it('execute(): blocks an untrusted, unapproved task before touching tmux — marks pending_approval', async () => {
    const task = makeTask({ serverName: 'local-server', unitId: 10, inputTrust: 'untrusted', executionApprovedFingerprintHash: null });
    const { useCase, taskRepo, tmux } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [makeUnit({ id: 10 })],
      projectServer: gateProjectServer,
    });

    await expect(useCase.execute(10, 1)).rejects.toThrow(/requires approval/);

    expect(tmux.createWindow).not.toHaveBeenCalled();
    // pendingOperation 'execute' lets the approval handler resume via
    // execute() rather than re-inferring it from task.tmuxWindow (Issue #328
    // third-round review finding 1).
    expect(taskRepo.recordExecutionGateBlock).toHaveBeenCalledWith(1, { pendingOperation: 'execute', priorStatus: 'open', manifestHash: expect.any(String) });
  });

  it('execute(): allows an untrusted task whose approval hash matches the current fingerprint', async () => {
    const { resolveExecutionManifest, hashExecutionManifest } = await import('./ExecutionManifest.js');
    const task = makeTask({
      serverName: 'local-server',
      unitId: 10,
      description: 'do the thing',
      inputTrust: 'untrusted',
    });
    const { useCase, tmux, unitRepo, projectRepo, projectServerRepo, serverRepo, projectSecretRepo, unitTypeLoader, sidekickLoader } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [makeUnit({ id: 10 })],
      projectServer: gateProjectServer,
    });
    const { manifest } = resolveExecutionManifest(task, { unitRepo, projectRepo, projectServerRepo, serverRepo, projectSecretRepo: projectSecretRepo as any, unitTypeLoader: unitTypeLoader as any, sidekickLoader: sidekickLoader as any });
    task.executionApprovedFingerprintHash = hashExecutionManifest(manifest);

    await useCase.execute(10, 1);

    expect(tmux.createWindow).toHaveBeenCalled();
  });

  it('execute(): denies outright under a "deny" project server policy, without changing task status', async () => {
    const task = makeTask({ serverName: 'local-server', unitId: 10, inputTrust: 'untrusted' });
    const { useCase, taskRepo, tmux } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [makeUnit({ id: 10 })],
      projectServer: { ...gateProjectServer, inputPolicy: 'deny' },
    });

    await expect(useCase.execute(10, 1)).rejects.toThrow(/denied/);

    expect(tmux.createWindow).not.toHaveBeenCalled();
    expect(taskRepo.updateStatus).not.toHaveBeenCalled();
  });

  it('execute(): does not gate a trusted task even with no project_servers row configured', async () => {
    const task = makeTask({ serverName: 'local-server', unitId: 10, inputTrust: 'trusted' });
    const { useCase, tmux } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [makeUnit({ id: 10 })],
      // no projectServer -> projectServerRepo.find() returns null
    });

    await useCase.execute(10, 1);

    expect(tmux.createWindow).toHaveBeenCalled();
  });

  it('followUp(): blocks resuming an untrusted task with a stale approval, before any tmux call', async () => {
    const task = makeTask({ serverName: 'local-server', unitId: 10, tmuxWindow: 'task-1', inputTrust: 'untrusted', executionApprovedFingerprintHash: null });
    const { useCase, taskRepo, tmux } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [makeUnit({ id: 10 })],
      projectServer: gateProjectServer,
    });

    await expect(useCase.followUp(10, 1, 'please continue')).rejects.toThrow(/requires approval/);

    expect(tmux.listSessions).not.toHaveBeenCalled();
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    // pendingOperation 'resume' lets the approval handler resume via
    // resumeStateMachine() rather than re-inferring it from task.tmuxWindow
    // (Issue #328 third-round review finding 1).
    expect(taskRepo.recordExecutionGateBlock).toHaveBeenCalledWith(1, { pendingOperation: 'resume', priorStatus: 'open', manifestHash: expect.any(String) });
  });

  it('resumeStateMachine(): blocks resuming an untrusted task with a stale approval', async () => {
    const task = makeTask({ serverName: 'local-server', unitId: 10, tmuxWindow: 'task-1', currentPhase: null, inputTrust: 'untrusted', executionApprovedFingerprintHash: null });
    const { useCase, taskRepo } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [makeUnit({ id: 10 })],
      projectServer: gateProjectServer,
    });

    await expect(useCase.resumeStateMachine(10, 1)).rejects.toThrow(/requires approval/);

    expect(taskRepo.recordExecutionGateBlock).toHaveBeenCalledWith(1, { pendingOperation: 'resume', priorStatus: 'open', manifestHash: expect.any(String) });
  });

  it('a SECOND blocked operation (followUp, after execute already recorded a block) does not overwrite the FIRST pendingOperation/pendingOperationPriorStatus (Issue #328 review round)', async () => {
    const task = makeTask({
      serverName: 'local-server', unitId: 10, inputTrust: 'untrusted', executionApprovedFingerprintHash: null,
      status: 'review',
    });
    const { useCase, taskRepo, logRepo } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [makeUnit({ id: 10 })],
      projectServer: gateProjectServer,
    });

    // First block: execute() records pendingOperation='execute',
    // pendingOperationPriorStatus='review' (the task's real status at the
    // time).
    await expect(useCase.execute(10, 1)).rejects.toThrow(/requires approval/);
    expect(task.pendingOperation).toBe('execute');
    expect(task.pendingOperationPriorStatus).toBe('review');
    expect(task.status).toBe('pending_approval');

    // Second, later-arriving block for the SAME still-unapproved task: a
    // follow-up request must not overwrite the first block's operation, and
    // — the sharper regression — must not read task.status as
    // 'pending_approval' (what the first block just set) and persist THAT as
    // pendingOperationPriorStatus, permanently losing the real prior status
    // ('review').
    await expect(useCase.followUp(10, 1, 'please continue')).rejects.toThrow(/requires approval/);
    expect(task.pendingOperation).toBe('execute');
    expect(task.pendingOperationPriorStatus).toBe('review');
    expect(task.status).toBe('pending_approval');

    // recordExecutionGateBlock was attempted twice (once per blocked call)
    // but only the first actually recorded — the mock harness's
    // recordExecutionGateBlock returns false once task.pendingOperation is
    // already non-null (mirrors SqliteTaskRepository's real guard).
    expect(taskRepo.recordExecutionGateBlock).toHaveBeenCalledTimes(2);
    expect(taskRepo.recordExecutionGateBlock).toHaveBeenNthCalledWith(1, 1, { pendingOperation: 'execute', priorStatus: 'review', manifestHash: expect.any(String) });
    expect(taskRepo.recordExecutionGateBlock).toHaveBeenNthCalledWith(2, 1, { pendingOperation: 'resume', priorStatus: 'pending_approval', manifestHash: expect.any(String) });

    // Exactly one 'status_change' notification went out (from the FIRST
    // block) — the second, no-op block must not emit a duplicate/misleading
    // one reporting 'resume' as the operation that will run on approval.
    const statusChangeCalls = (logRepo.append as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[2] === 'status_change' && (c[3] as { status?: string })?.status === 'pending_approval',
    );
    expect(statusChangeCalls).toHaveLength(1);
    expect(statusChangeCalls[0][3]).toEqual({ status: 'pending_approval', operation: 'execute' });
    expect(logRepo.append).toHaveBeenCalledWith(1, 10, 'command', { type: 'execution_gate_already_pending', operation: 'resume' });
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
      consumePendingApproval: vi.fn(() => false),
      recordExecutionGateBlock: vi.fn(() => true),
      preApproveExecution: vi.fn(() => true),
      countChildren: vi.fn(() => 0),
      countChildrenInGeneration: vi.fn(() => 0),
      clearTmuxWindowIfMatches: vi.fn((_id: number, expectedWindowName: string) => {
        if (task.tmuxWindow !== expectedWindowName) return false;
        task.tmuxWindow = null;
        return true;
      }),
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
      updateIsolationIntent: vi.fn(),
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
      findByProject: vi.fn(() => [{ projectId: 1, serverName: 'local-server', workingDirectory: '/work', branch: null, tmuxSession: 'azito', inputPolicy: 'manual-approval' as const }]),
      findByServer: vi.fn(() => []),
      find: vi.fn(() => ({ projectId: 1, serverName: 'local-server', workingDirectory: '/work', branch: null, tmuxSession: 'azito', inputPolicy: 'manual-approval' as const })),
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
      createWindow: vi.fn(async () => ({ result: { stdout: '', stderr: '', code: 0 }, windowName: 'task-1' })),
      resolvePaneId: vi.fn(async () => '%0'),
      killPane: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
      killWindow: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
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
    const supervisorRegistry = { isConnected: vi.fn(() => false), isBoundConnected: vi.fn(() => false), sendCommand: vi.fn(async () => {}), clearExitMarker: vi.fn(), issueLaunch: vi.fn(() => undefined) };
    const projectSecretRepo = { findByProjectWithValues: vi.fn(() => []), findByProject: vi.fn(() => []) };

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
      {
        get: vi.fn(() => ({ name: 'devops', label: 'DevOps', description: '', phases: [] })),
        getOrThrow: vi.fn(() => ({ name: 'devops', label: 'DevOps', description: '', phases: [] })),
      } as any,
      { check: vi.fn(async () => ({ ok: true, reasons: [], memAvailablePercent: null, loadPerCore: null, memAvailablePercentMin: 10, loadPerCoreMax: 2 })) } as any,
      projectSecretRepo as any,
      new EventEmitter(),
      { buildEnvForNewWindow: vi.fn(() => ({ env: {}, tokenId: 1 })), revokeGeneration: vi.fn() } as any,
      new KeyedMutex(),
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

  it('accepts a resolved worktree path containing shell metacharacters and reaches the pane only via the already-quoted `cd --` command (Issue #27 review finding 2: containment verification must not restrict the character set — that rejected legitimate directory names like `/srv/repo+tools`; the shell boundary at `cd -- ${shellQuote(...)}` is what stays safe, not an upstream filter)', async () => {
    // A directory name with shell metacharacters is legal on disk and must
    // be allowed through containment verification; only quoting at the
    // shell boundary (already done here via `shellQuote`) protects the
    // `cd` command.
    const unit = makeUnit({ id: 16, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ id: 9, serverName: 'local-server', unitId: 16 });
    const { useCase, tmux, windowRepo, worktreeServiceFactory } = buildUseCase({
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

    await useCase.execute(16, 9);

    expect(windowRepo.add).toHaveBeenCalled();
    const cdCall = tmux.sendKeys.mock.calls.find((call: unknown[]) => ((call as unknown[])[2] as string[])[0]?.startsWith('cd '));
    expect(cdCall).toBeDefined();
    const cdCommand = ((cdCall as unknown[])[2] as string[])[0];
    expect(cdCommand).toBe(`cd -- ${shellQuote(dangerousDir)}`);
  });

  it('rejects when the created worktree path resolves outside the project working directory (symlink escape)', async () => {
    const unit = makeUnit({ id: 13, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ id: 4, serverName: 'local-server', unitId: 13 });
    const { useCase, taskRepo, windowRepo, logRepo, worktreeServiceFactory, tmux, paneEnvService } = buildUseCase({
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
    // Issue #28 third-party review fix: 'failed' doesn't auto-revoke (see
    // TOKEN_REVOKING_STATUSES), so the just-created window's token
    // generation would otherwise leak — the rollback must kill the window
    // AND revoke it directly, once the kill is confirmed.
    expect(tmux.killWindow).toHaveBeenCalled();
    expect(paneEnvService.revokeGeneration).toHaveBeenCalledWith(101, 'worktree_path_rejected_rollback');
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

// Issue #28 third-party review: execute()/followUp() must apply the same
// rollback-safe window-rotation order respawn() already established (kill
// old window → confirm gone → rotate token → create; revoke the new
// generation if creation fails, whether by throwing or by resolving with a
// non-zero exit code). See WindowRotation.ts.
describe('ExecuteTaskUseCase window-rotation rollback safety (Issue #28 third-party review)', () => {
  it('execute(): aborts before rotating the token when killing the leftover task window fails (non-zero exit code)', async () => {
    const unit = makeUnit({ id: 30, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ id: 40, serverName: 'local-server', unitId: 30, tmuxWindow: 'old-window' });
    const { useCase, tmux, paneEnvService, windowRepo } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
      projectServer: null,
    });
    tmux.listSessions.mockResolvedValue([
      { name: 'azito', windows: [{ name: 'old-window', index: 5 }] },
    ]);
    // Agent-transport style failure: resolves (doesn't throw) with a
    // non-zero code — a bare await/`.then` here previously read this as
    // success (Issue #28 third-party review finding 2).
    tmux.killWindow.mockResolvedValue({ stdout: '', stderr: 'device busy', code: 1 });

    await expect(useCase.execute(30, 40)).rejects.toThrow(/Failed to kill window .* before rotating window/);

    expect(paneEnvService.buildEnvForNewWindow).not.toHaveBeenCalled();
    expect(tmux.createWindow).not.toHaveBeenCalled();
    expect(windowRepo.add).not.toHaveBeenCalled();
  });

  it('execute(): kills the whole leftover window (not just the active pane) so a surviving second pane cannot keep the old token alive (Issue #28 third-party review finding 1)', async () => {
    const unit = makeUnit({ id: 35, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ id: 45, serverName: 'local-server', unitId: 35, tmuxWindow: 'old-window' });
    const { useCase, tmux, windowRepo } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
      projectServer: null,
    });
    // The old task window has two panes (e.g. a split terminal the user
    // opened alongside the worker pane) — not modeled in this listSessions
    // mock's minimal { name, index } shape, but that's exactly the point:
    // confirmOldWindowGone must target the whole window regardless of how
    // many panes it holds. Only killWindow removes all of them; a killPane
    // call targeting just the active pane would leave a sibling pane (and
    // the old token it still holds) alive.
    tmux.listSessions.mockResolvedValue([
      { name: 'azito', windows: [{ name: 'old-window', index: 5 }] },
    ]);

    await useCase.execute(35, 45);

    expect(tmux.killWindow).toHaveBeenCalledWith(expect.anything(), 'azito:5');
    expect(tmux.killPane).not.toHaveBeenCalled();
    expect(windowRepo.add).toHaveBeenCalled();
  });

  it('execute(): revokes the new token generation and does not persist the window when createWindow resolves with a non-zero exit code', async () => {
    const unit = makeUnit({ id: 31, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ id: 41, serverName: 'local-server', unitId: 31, tmuxWindow: null });
    const { useCase, tmux, paneEnvService, windowRepo, taskRepo } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
      projectServer: null,
    });
    tmux.createWindow.mockResolvedValue({ result: { stdout: '', stderr: 'boom', code: 1 }, windowName: 'w1' });

    await expect(useCase.execute(31, 41)).rejects.toThrow(/Failed to create tmux window/);

    expect(paneEnvService.revokeGeneration).toHaveBeenCalledWith(101, 'execute_create_failed');
    expect(windowRepo.add).not.toHaveBeenCalled();
    expect(taskRepo.update).not.toHaveBeenCalledWith(41, expect.objectContaining({ tmuxWindow: 'w1' }));
  });

  it('execute(): revokes the new token generation when createWindow throws', async () => {
    const unit = makeUnit({ id: 32, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ id: 42, serverName: 'local-server', unitId: 32, tmuxWindow: null });
    const { useCase, tmux, paneEnvService, windowRepo } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
      projectServer: null,
    });
    tmux.createWindow.mockRejectedValue(new Error('tmux new-window failed'));

    await expect(useCase.execute(32, 42)).rejects.toThrow(/Failed to create tmux window/);

    expect(paneEnvService.revokeGeneration).toHaveBeenCalledWith(101, 'execute_create_failed');
    expect(windowRepo.add).not.toHaveBeenCalled();
  });

  it('followUp(): revokes the new token generation and does not persist tmuxWindow when createWindow resolves with a non-zero exit code', async () => {
    const unit = makeUnit({ id: 33, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ id: 43, serverName: 'local-server', unitId: 33, tmuxWindow: null });
    const { useCase, tmux, paneEnvService, taskRepo } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
      projectServer: null,
    });
    tmux.createWindow.mockResolvedValue({ result: { stdout: '', stderr: 'boom', code: 1 }, windowName: 'w2' });

    await expect(useCase.followUp(33, 43, 'continue')).rejects.toThrow(/Failed to create tmux window/);

    expect(paneEnvService.revokeGeneration).toHaveBeenCalledWith(101, 'followup_create_failed');
    expect(taskRepo.update).not.toHaveBeenCalledWith(43, expect.objectContaining({ tmuxWindow: 'w2' }));
  });

  it('followUp(): revokes the new token generation when createWindow throws', async () => {
    const unit = makeUnit({ id: 34, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ id: 44, serverName: 'local-server', unitId: 34, tmuxWindow: null });
    const { useCase, tmux, paneEnvService } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
      projectServer: null,
    });
    tmux.createWindow.mockRejectedValue(new Error('tmux new-window failed'));

    await expect(useCase.followUp(34, 44, 'continue')).rejects.toThrow(/Failed to create tmux window/);

    expect(paneEnvService.revokeGeneration).toHaveBeenCalledWith(101, 'followup_create_failed');
  });
});

// Issue #28 third-party review, second round: all 3 rollback sites used to
// clear their DB reference to the just-created window (tmuxWindow: null /
// removing the Window row) either before confirming the kill, or regardless
// of whether it succeeded. A kill failure then left a still-live,
// still-token-authenticated window completely untracked. The 3 sites now
// route through WindowRotation.rollbackWindowReference, which only clears
// the reference once resolveKillOutcome confirms the window is actually
// gone; on failure the reference (and the token) is left alone.
describe('ExecuteTaskUseCase rollback keeps the window reference tracked when the rollback kill fails (Issue #28 third-party review, second round)', () => {
  let allowedRoot: string;
  let outsideDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    allowedRoot = mkdtempSync(path.join(tmpdir(), 'azito-exec-rollback-root-'));
    outsideDir = mkdtempSync(path.join(tmpdir(), 'azito-exec-rollback-outside-'));
  });

  afterEach(() => {
    rmSync(allowedRoot, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('execute(): worktree-creation-failure rollback keeps tmuxWindow set and does not revoke the generation when the rollback kill fails', async () => {
    const unit = makeUnit({ id: 50, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ id: 60, serverName: 'local-server', unitId: 50 });
    const { useCase, tmux, taskRepo, paneEnvService, worktreeServiceFactory } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
      projectServer: { workingDirectory: allowedRoot, branch: null, tmuxSession: 'azito' },
    });
    worktreeServiceFactory.create.mockReturnValue({
      create: vi.fn(async () => { throw new Error('worktree failed'); }),
    });
    tmux.killWindow.mockResolvedValue({ stdout: '', stderr: 'device busy', code: 1 });

    await expect(useCase.execute(50, 60)).rejects.toThrow(/Worktree creation failed/);

    expect(taskRepo.update).not.toHaveBeenCalledWith(60, expect.objectContaining({ tmuxWindow: null }));
    expect(paneEnvService.revokeGeneration).not.toHaveBeenCalled();
  });

  it('execute(): worktree-path-rejection rollback keeps tmuxWindow set and does not revoke the generation when the rollback kill fails', async () => {
    const unit = makeUnit({ id: 51, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ id: 61, serverName: 'local-server', unitId: 51 });
    const { useCase, tmux, taskRepo, paneEnvService, worktreeServiceFactory } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
      projectServer: { workingDirectory: allowedRoot, branch: null, tmuxSession: 'azito' },
    });
    worktreeServiceFactory.create.mockReturnValue({
      create: vi.fn(async () => ({ path: outsideDir, branch: 'task/61-slug' })),
      remove: vi.fn(async () => {}),
    });
    tmux.killWindow.mockResolvedValue({ stdout: '', stderr: 'device busy', code: 1 });

    await expect(useCase.execute(51, 61)).rejects.toThrow(/Worktree path rejected/);

    expect(taskRepo.update).not.toHaveBeenCalledWith(61, expect.objectContaining({ tmuxWindow: null }));
    expect(paneEnvService.revokeGeneration).not.toHaveBeenCalled();
  });

  it('followUp(): working-directory-rejection rollback keeps tmuxWindow set and does not revoke the generation when the rollback kill fails', async () => {
    const unit = makeUnit({ id: 52, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ id: 62, serverName: 'local-server', unitId: 52, tmuxWindow: null, workingDirectory: outsideDir });
    const { useCase, tmux, taskRepo, paneEnvService, worktreeServiceFactory } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
      projectServer: { workingDirectory: allowedRoot, branch: null, tmuxSession: 'azito' },
    });
    worktreeServiceFactory.create.mockReturnValue({ exists: vi.fn(async () => false) });
    tmux.killWindow.mockResolvedValue({ stdout: '', stderr: 'device busy', code: 1 });

    await expect(useCase.followUp(52, 62, 'please continue')).rejects.toThrow(/Follow-up working directory rejected/);

    expect(taskRepo.update).not.toHaveBeenCalledWith(62, expect.objectContaining({ tmuxWindow: null }));
    expect(paneEnvService.revokeGeneration).not.toHaveBeenCalled();
  });
});

// Fix 3 (Issue #28 third-party review, Important finding): the worktree
// creation step (and its own failure rollback) runs OUTSIDE
// runExclusiveForTask — see WindowRotation.ts's doc comment for why (the lock
// only needs to cover confirm-kill -> rotate-token -> create -> persist, not
// the potentially-slow worktree creation that follows). That gap means a
// SECOND, concurrent execute()/followUp() for the SAME task can acquire the
// lock, create a NEWER window generation, and persist its own `tmuxWindow`
// while the FIRST call's worktree step is still failing. These tests
// reproduce that interleaving directly (mutating the shared task object mid-
// worktree-creation, exactly where the real race would land) and confirm the
// rollback no longer clobbers the newer generation's window reference — only
// the failed call's OWN token generation gets revoked.
describe('ExecuteTaskUseCase rollback does not clobber a newer window generation persisted by a concurrent execute()/followUp() for the same task (Issue #28 third-party review, Fix 3)', () => {
  let allowedRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    allowedRoot = mkdtempSync(path.join(tmpdir(), 'azito-exec-race-root-'));
  });

  afterEach(() => {
    rmSync(allowedRoot, { recursive: true, force: true });
  });

  it('execute(): a worktree-creation failure does not null out a newer tmuxWindow a concurrent rotation already persisted', async () => {
    const unit = makeUnit({ id: 70, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ id: 70, serverName: 'local-server', unitId: 70 });
    const { useCase, taskRepo, paneEnvService, worktreeServiceFactory } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
      projectServer: { workingDirectory: allowedRoot, branch: null, tmuxSession: 'azito' },
    });
    worktreeServiceFactory.create.mockReturnValue({
      // This runs AFTER runExclusiveForTask's window-creation span has
      // already released the lock and persisted `tmuxWindow: 'w1'` (this
      // call's own generation) — exactly where a concurrent execute()/
      // followUp() for the same task would slot in, acquire the lock, create
      // window 'w2', and persist ITS OWN tmuxWindow before this worktree
      // creation fails.
      create: vi.fn(async () => {
        task.tmuxWindow = 'w2';
        throw new Error('worktree failed');
      }),
    });

    await expect(useCase.execute(70, 70)).rejects.toThrow(/Worktree creation failed/);

    // The rollback must have attempted to clear ITS OWN generation ('w1')...
    expect(taskRepo.clearTmuxWindowIfMatches).toHaveBeenCalledWith(70, 'w1');
    // ...but since the row had already moved on to 'w2', the clear must be a
    // no-op — the newer generation's window reference stays intact.
    expect(task.tmuxWindow).toBe('w2');
    // The failed call's OWN token generation is still revoked regardless —
    // token cleanup for the generation THIS call issued must not depend on
    // whether the DB reference clear succeeded.
    expect(paneEnvService.revokeGeneration).toHaveBeenCalledWith(101, 'worktree_creation_failed_rollback');
  });

  it('followUp(): a working-directory-rejection rollback does not null out a newer tmuxWindow a concurrent rotation already persisted', async () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'azito-exec-race-outside-'));
    try {
      const unit = makeUnit({ id: 71, workerType: 'claude', workerModel: 'opus' });
      const task = makeTask({ id: 71, serverName: 'local-server', unitId: 71, tmuxWindow: null, worktreePath: outsideDir });
      const { useCase, taskRepo, paneEnvService, worktreeServiceFactory } = buildUseCase({
        task,
        project: makeProject({ defaultUnitId: null }),
        units: [unit],
        projectServer: { workingDirectory: allowedRoot, branch: null, tmuxSession: 'azito' },
      });
      worktreeServiceFactory.create.mockReturnValue({
        // followUp() awaits this while resolving followUpDir, which runs
        // after window creation released the lock and persisted
        // `tmuxWindow: 'w1'` — same race window as execute() above,
        // simulated the same way. Returning true routes followUpDir to
        // task.worktreePath (outsideDir), which then fails containment.
        exists: vi.fn(async () => {
          task.tmuxWindow = 'w2';
          return true;
        }),
      });

      await expect(useCase.followUp(71, 71, 'please continue')).rejects.toThrow(/Follow-up working directory rejected/);

      expect(taskRepo.clearTmuxWindowIfMatches).toHaveBeenCalledWith(71, 'w1');
      expect(task.tmuxWindow).toBe('w2');
      expect(paneEnvService.revokeGeneration).toHaveBeenCalledWith(101, 'followup_working_directory_rejected_rollback');
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
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
    const { useCase, taskRepo, worktreeServiceFactory, tmux, paneEnvService } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
      projectServer: { workingDirectory: allowedRoot, branch: null, tmuxSession: 'azito' },
    });
    worktreeServiceFactory.create.mockReturnValue({ exists: vi.fn(async () => false) });

    await expect(useCase.followUp(20, 7, 'please continue')).rejects.toThrow(/Follow-up working directory rejected/);

    expect(taskRepo.update).toHaveBeenCalledWith(7, expect.objectContaining({ status: 'failed' }));
    // Issue #28 third-party review fix: this branch only runs when
    // !windowExists just created a fresh window (and rotated the task
    // token) for this follow-up — 'failed' doesn't auto-revoke, so the
    // rollback must kill the window AND revoke it directly.
    expect(tmux.killWindow).toHaveBeenCalled();
    expect(paneEnvService.revokeGeneration).toHaveBeenCalledWith(101, 'followup_working_directory_rejected_rollback');
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

// ─── Issue #328 review round: execute()-entry regression for the
// approval-self-invalidation bug ───
//
// Every other execution-gate test in this file (and in PhaseLoopRunner.test.ts)
// calls `stateMachineLoop` directly — that never exercises the worktree
// creation `this.taskRepo.update(taskId, { ... branch: wt.branch })` write
// ExecuteTaskUseCase.execute() used to make BEFORE handing off to the phase
// loop. A task approved with no client-specified branch (task.branch === null)
// got a freshly auto-generated worktree branch written back into that same
// `task.branch` field — the exact field the approval fingerprint hashes as
// `branches.work` — so the very first phase-boundary reverification inside
// the loop (which re-resolves the manifest from the NOW-mutated task) saw a
// hash mismatch and threw the task straight back to `pending_approval`, with
// the tmux window and worktree already created. This test drives the real
// `execute()` entry point through two phases with a mutable fake task
// repository (so the self-overwrite, if reintroduced, actually manifests) and
// asserts the run completes without ever bouncing back to pending_approval.
describe('ExecuteTaskUseCase.execute() execution-gate self-invalidation regression (Issue #328 review round)', () => {
  function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (cond()) { resolve(); return; }
        if (Date.now() - start > timeoutMs) { reject(new Error('waitFor: timed out')); return; }
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  class FakeTaskRepo {
    private task: Task;
    constructor(initial: Task) { this.task = initial; }
    findAll = () => [this.task];
    findByProject = () => [this.task];
    findByUnit = () => [this.task];
    findByStatus = () => [this.task];
    findAgentSessionIdsByServer = () => new Set<string>();
    findById = (id: number) => (id === this.task.id ? { ...this.task } : null);
    create = (): number => { throw new Error('FakeTaskRepo.create not implemented'); };
    update = (id: number, data: Partial<Task>) => {
      if (id !== this.task.id) return;
      this.task = { ...this.task, ...data };
    };
    updateStatus = (id: number, status: Task['status']) => {
      if (id !== this.task.id) return;
      this.task = { ...this.task, status };
    };
    updateCurrentPhase = (id: number, phase: string | null) => {
      if (id !== this.task.id) return;
      this.task = { ...this.task, currentPhase: phase };
    };
    touch = () => {};
    delete = () => {};
    consumePendingApproval = () => false;
    snapshot = () => this.task;
  }

  it('approves an untrusted task with no client-specified branch, runs execute() through two phases, and never bounces back to pending_approval', async () => {
    const CUSTOM_UNIT_TYPE = {
      name: 'two-phase', label: 'Two Phase', description: '', phases: [
        { name: 'phase1', label: 'Phase 1', tags: ['phase1'], questions: false, testFailed: false, planApproval: false, selfReviewRetry: false, pushVerify: false },
        { name: 'phase2', label: 'Phase 2', tags: ['phase2'], questions: false, testFailed: false, planApproval: false, selfReviewRetry: false, pushVerify: false },
      ],
    };
    const fixedUnit = makeUnit({
      id: 30, unitType: 'two-phase', workerType: null, workerModel: null,
      workerExecutionMode: 'tmux-pipe', workerRuntime: 'tui',
    });
    const fixedProject = makeProject({ defaultUnitId: null, repositories: [] });
    const fixedSidekick = {
      name: 'test-sidekick', description: '', tags: ['phase1', 'phase2'], isDefault: true,
      layer: 'builtin' as const, overridesBuiltin: false, dir: '/fake/sidekick',
      body: 'Do the {{task.title}} phase.', hasScripts: false, hasReferences: false,
    };

    const unitRepo: IUnitRepository = {
      findAll: vi.fn(() => [fixedUnit]),
      findById: vi.fn((id: number) => (id === fixedUnit.id ? fixedUnit : null)),
      create: vi.fn(() => 1),
      update: vi.fn(),
      delete: vi.fn(),
    };
    const projectRepo: IProjectRepository = {
      findAll: vi.fn(() => []),
      findById: vi.fn(() => fixedProject),
      create: vi.fn(() => 1),
      update: vi.fn(),
      delete: vi.fn(),
      addRepository: vi.fn(() => 1),
      findRepositoryById: vi.fn(() => null),
      removeRepository: vi.fn(),
    };
    const projectServerRepo: IProjectServerRepository = {
      findByProject: vi.fn(() => []),
      findByServer: vi.fn(() => []),
      find: vi.fn(() => null),
      upsert: vi.fn(),
      remove: vi.fn(),
    };
    const server = makeServer({ name: 'local-server', type: 'local' });
    const serverRepo: IServerRepository = {
      findAll: vi.fn(() => [server]),
      findByName: vi.fn(() => server),
      create: vi.fn(),
      update: vi.fn(),
      updateAgentVersion: vi.fn(),
      updateFingerprint: vi.fn(),
      clearFingerprint: vi.fn(),
      updateIsolationIntent: vi.fn(),
      delete: vi.fn(),
    };
    const projectSecretRepo = { findByProjectWithValues: vi.fn(() => []), findByProject: vi.fn(() => []) };
    const unitTypeLoader = {
      get: vi.fn(() => CUSTOM_UNIT_TYPE),
      getOrThrow: vi.fn(() => CUSTOM_UNIT_TYPE),
    };
    const sidekickLoader = {
      list: vi.fn(() => []),
      findByName: vi.fn(() => null),
      findDefaultForTag: vi.fn(() => fixedSidekick),
      findDefaultForPhase: vi.fn(() => fixedSidekick),
      invalidateCache: vi.fn(),
    };

    // The task as approved: untrusted, no client-specified branch. The
    // approval fingerprint is computed off this exact snapshot, BEFORE
    // execute() ever touches the worktree.
    const approvedTask = makeTask({
      id: 501, projectId: fixedProject.id, unitId: fixedUnit.id, serverName: server.name,
      inputTrust: 'untrusted', branch: null, worktreeBranch: null, worktreePath: null,
      workingDirectory: '/fake/work', status: 'open',
    });
    const { resolveExecutionManifest, hashExecutionManifest } = await import('./ExecutionManifest.js');
    const { manifest } = resolveExecutionManifest(approvedTask, {
      unitRepo, projectRepo, projectServerRepo, serverRepo,
      projectSecretRepo: projectSecretRepo as any, unitTypeLoader: unitTypeLoader as any, sidekickLoader: sidekickLoader as any,
    });
    approvedTask.executionApprovedFingerprintHash = hashExecutionManifest(manifest);

    const taskRepo = new FakeTaskRepo(approvedTask);

    const logRepo = { append: vi.fn(), findByTask: vi.fn(() => []), findByUnit: vi.fn(() => []) };

    // paneStreamFactory: captures every 'marker' listener registered by
    // WorkerWaiter.waitForWorker (the signal-stream path, tmux-pipe mode) so
    // the test can fire a "phase_complete" marker on demand instead of
    // waiting on real tmux output.
    const markerListeners: Array<(type: string, raw: string) => void> = [];
    const paneStreamFactory = {
      create: vi.fn((id: string) => ({
        start: vi.fn(),
        stop: vi.fn(),
        on: vi.fn((event: string, cb: (type: string, raw: string) => void) => {
          if (event === 'marker') markerListeners.push(cb);
        }),
        getBuffer: () => 'PHASE_COMPLETE',
        getFilePath: () => `/tmp/${id}`,
        setMarkers: vi.fn(),
        enableMarkerDetection: vi.fn(),
      })),
    };

    const tmux = {
      listSessions: vi.fn(async () => []),
      createSession: vi.fn(async () => {}),
      createWindow: vi.fn(async () => ({ result: { stdout: '', stderr: '', code: 0 }, windowName: 'w1' })),
      resolvePaneId: vi.fn(async () => '%0'),
      killPane: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
      killWindow: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
      sendKeys: vi.fn(async () => {}),
      checkPaneExists: vi.fn(async () => true),
      uiTokenEnvForServer: vi.fn(() => ({})),
      startPipePane: vi.fn(async () => {}),
      stopPipePane: vi.fn(async () => {}),
      execCommand: vi.fn(async () => ({ stdout: '' })),
      // 'Thinking...' satisfies verifyPromptDelivery's isPromptDelivered()
      // check on the first attempt — avoids an extra 3s retry sleep.
      capturePane: vi.fn(async () => ({ stdout: 'Thinking... (esc to interrupt)' })),
    };

    const worktreeServiceFactory = {
      create: vi.fn(() => ({
        // The auto-generated worktree branch — deliberately DIFFERENT from
        // approvedTask.branch (null) to reproduce the bug: if execute() ever
        // writes this back into task.branch, the next reverification's
        // fingerprint changes.
        create: vi.fn(async () => ({ path: '/fake/work/.worktrees/task-501', branch: 'task/501-generated' })),
        exists: vi.fn(async () => false),
      })),
    };
    const gitProvider = { findPullRequestByBranch: vi.fn(async () => null) };
    const transportFactory = { getTransport: vi.fn(() => ({})) };
    const paneClassifier = {};
    const contentExtractor = { generateSlug: vi.fn(async () => 'slug'), extractPlan: vi.fn(async () => ({ planMarkdown: null })) };
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
    const turnRepo = { supersedeRunning: vi.fn(), create: vi.fn(), findById: vi.fn(() => null), findLatestEventByType: vi.fn(() => null), markEnded: vi.fn(), appendEvent: vi.fn() };
    const turnSignalHub = { emitSignal: vi.fn(), subscribe: vi.fn(() => () => {}) };
    const supervisorRegistry = { isConnected: vi.fn(() => false), isBoundConnected: vi.fn(() => false), sendCommand: vi.fn(async () => {}), clearExitMarker: vi.fn(), issueLaunch: vi.fn(() => undefined) };

    const useCase = new ExecuteTaskUseCase(
      taskRepo as any,
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
      unitTypeLoader as any,
      { check: vi.fn(async () => ({ ok: true, reasons: [], memAvailablePercent: null, loadPerCore: null, memAvailablePercentMin: 10, loadPerCoreMax: 2 })) } as any,
      projectSecretRepo as any,
      new EventEmitter(),
      { buildEnvForNewWindow: vi.fn(() => ({ env: {}, tokenId: 1 })), revokeGeneration: vi.fn() } as any,
      new KeyedMutex(),
    );

    // execute() itself resolves once setup (session/window/worktree
    // creation, launch) is done — it does NOT await the phase loop, which
    // keeps running in the background (see execute()'s `runLoop` handling).
    await useCase.execute(fixedUnit.id, approvedTask.id);

    // The worktree-creation write must never have echoed the auto-generated
    // branch back into task.branch (the field the approval fingerprint
    // hashes) — this is the core assertion for fix 1.
    expect(taskRepo.snapshot().branch).toBeNull();
    expect(taskRepo.snapshot().worktreeBranch).toBe('task/501-generated');

    // Phase 1: let the loop reach waitForWorker (past verifyPromptDelivery's
    // delivery check), then fire its phase_complete marker.
    await waitFor(() => markerListeners.length >= 1, 15_000);
    markerListeners.shift()!('phase_complete', '');

    // Phase 2: the SECOND phase-boundary reverification is exactly "crossing
    // the first phase boundary" the regression this test guards against —
    // it must not have blocked here either.
    await waitFor(() => markerListeners.length >= 1, 15_000);
    markerListeners.shift()!('phase_complete', '');

    // The run must reach its normal terminal state ('review'), never
    // 'pending_approval' — the acceptance criterion from the review.
    await waitFor(() => taskRepo.snapshot().status === 'review', 15_000);

    expect(taskRepo.snapshot().status).toBe('review');
    expect(taskRepo.snapshot().pendingOperation).toBeNull();
  }, 60_000);
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
