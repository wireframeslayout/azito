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
    sleepAfterPush: null,
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
    isolationReport: null, isolationCleanupReport: null,
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
    sleepAfterPush: false,
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
  projectServer?: { workingDirectory: string | null; branch: string | null; tmuxSession: string; inputPolicy?: 'deny' | 'manual-approval' | 'allow'; distributeCode?: boolean; distributionRepositoryId?: number | null } | null;
  /** When set, overrides findByProject entirely (e.g. to simulate multiple project servers). */
  projectServersList?: Array<{ projectId: number; serverName: string; workingDirectory: string | null; branch: string | null; tmuxSession: string; inputPolicy?: 'deny' | 'manual-approval' | 'allow'; distributeCode?: boolean; distributionRepositoryId?: number | null }>;
  /** When set, overrides the server returned by serverRepo.findByName (default: makeServer(), type 'local'). */
  server?: ServerConfig;
  /** Issue #87 Phase 2: stubs projectRepo.findRepositoryById — a repository row with a token, for fetch-distribution gate tests. */
  repository?: { id: number; url: string; provider: 'github' | 'gitlab'; owner: string | null; repoName: string | null; token: string | null };
  /** Issue #87 Phase 2: injected as the constructor's fetchDistributionService param — when set, the fetch-distribution gate can actually run. */
  fetchDistributionService?: { distribute: ReturnType<typeof vi.fn> };
  /** Issue #29 Step 3a: defaults to true so pre-existing tests (all predating 'allow') are unaffected. */
  scopedAuthEnabled?: boolean;
  /**
   * Issue #87 review (forge/87-mirror follow-up), Important finding 3:
   * injected as the constructor's `distributionStateRepo` param — used by
   * `shouldClearRecordedDistributionRepository` to decide whether a
   * not-required-this-run execute() may clear `task.distributionRepositoryId`.
   * Defaults to `null` (not wired), matching the pre-existing default for
   * every test that doesn't care — per this fix's own "insufficient
   * information fails toward keeping the record" rule, that means the
   * record is left untouched when distribution is not required this run.
   */
  distributionStateRepo?: { find: ReturnType<typeof vi.fn> } | null;
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
    // Issue #87 third-party review, Important finding 1 (refined per second
    // review pass): mirrors SqliteTaskRepository's guarded UPDATE — writes
    // `status` when the current tmuxWindow still matches the caller's own
    // generation's window name, OR when it has already been cleared to
    // NULL by the ordinary window-destruction path for this SAME
    // generation (a newer generation always writes its own window name
    // first, so NULL is never evidence of a takeover). Same CAS shape as
    // clearTmuxWindowIfMatches above, plus the NULL branch.
    updateStatusIfWindowMatches: vi.fn((_id: number, expectedWindowName: string, status: Task['status']) => {
      if (opts.task.tmuxWindow !== expectedWindowName && opts.task.tmuxWindow !== null) return false;
      opts.task.status = status;
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
    findRepositoryById: vi.fn(() => opts.repository ? { ...opts.repository, name: null } : null),
    updateRepositoryToken: vi.fn(),
    removeRepository: vi.fn(),
    findRepositoryCredentialsByIds: vi.fn(() => []),
  };

  const projectServerRepo: IProjectServerRepository = {
    findByProject: vi.fn(() => (opts.projectServersList ?? (opts.projectServer ? [{ projectId: 1, serverName: 'local-server', ...opts.projectServer }] : [])).map((ps) => ({ inputPolicy: 'manual-approval' as const, distributeCode: false, distributionRepositoryId: null, ...ps }))),
    findByServer: vi.fn(() => []),
    find: vi.fn(() => (opts.projectServer ? { projectId: 1, serverName: 'local-server', inputPolicy: 'manual-approval' as const, distributeCode: false, distributionRepositoryId: null, ...opts.projectServer } : null)),
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
    execCommand: vi.fn(async (_server: unknown, _cmd: string) => ({ stdout: '', stderr: '', code: 0 })),
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
    opts.scopedAuthEnabled ?? true,
      async () => [],
    null,
    (opts.fetchDistributionService as any) ?? null,
    (opts.distributionStateRepo as any) ?? null,
  );

  return { useCase, taskRepo, windowRepo, logRepo, tmux, supervisorRegistry, worktreeServiceFactory, transportFactory, unitRepo, projectRepo, projectServerRepo, serverRepo, projectSecretRepo, unitTypeLoader, sidekickLoader, paneEnvService, gitProvider };
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

  // Issue #29 review (10th pass): Critical finding 1 (execute()'s session
  // bootstrap must run inside the isolation lock, against a freshly re-read
  // server) and Important finding 3 (the fresh `server` createRotatedWindow
  // returns must be used for everything downstream, not the `server`
  // resolved at the top of execute()). serverRepo.findByName is stubbed to
  // hand back a distinct ServerConfig (tagged via `agentVersion`) on every
  // call, so each server-carrying call this run makes can be checked against
  // exactly which lock-and-refetch span actually produced the object it saw.
  it('uses the server row re-read inside each isolation-lock span for every subsequent tmux/transport call, not the server resolved before execute() started', async () => {
    const unit = makeUnit({ id: 60, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ id: 60, serverName: 'local-server', unitId: 60, workingDirectory: '/some/work/dir' });
    const { useCase, serverRepo, tmux, transportFactory, worktreeServiceFactory } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
      // No projectServer configured -> allowedRoot is null -> containment is
      // skipped and workingDir resolves straight from task.workingDirectory,
      // keeping this test focused on server freshness rather than PathContainment.
      projectServer: null,
    });
    let generation = 0;
    (serverRepo.findByName as ReturnType<typeof vi.fn>).mockImplementation(() => {
      generation += 1;
      return makeServer({ agentVersion: `gen-${generation}` });
    });
    worktreeServiceFactory.create.mockReturnValue({
      create: vi.fn(async () => ({ path: '/some/work/dir/.worktrees/task-60', branch: 'task/60' })),
    });

    await useCase.execute(60, 60);

    const createSessionServer = (tmux.createSession as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const createWindowServer = (tmux.createWindow as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const resolvePaneIdServer = (tmux.resolvePaneId as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const getTransportServer = (transportFactory.getTransport as ReturnType<typeof vi.fn>).mock.calls[0][0];

    // ensureSessionWithLock's lock span re-read the server for the session
    // bootstrap — createSession must see that row.
    expect(createSessionServer.agentVersion).toBeDefined();
    // createRotatedWindow's own, LATER lock span re-read the server again
    // for the real task window — createWindow must see a STRICTLY NEWER row
    // than ensureSessionWithLock's, never the same or an earlier one.
    expect(createWindowServer.agentVersion).not.toBe(createSessionServer.agentVersion);
    // Everything execute() does after createRotatedWindow returns
    // (resolvePaneId, the worktree transport) must keep using THAT exact
    // fresh row, not fall back to the `server` resolved before either lock
    // span ran.
    expect(resolvePaneIdServer.agentVersion).toBe(createWindowServer.agentVersion);
    expect(getTransportServer.agentVersion).toBe(createWindowServer.agentVersion);
  });

  // Same Issue #29 review (10th pass) fix as execute()'s own test above,
  // exercised through followUp()'s "no window yet" branch instead (the
  // branch that actually calls createRotatedWindow — the common "resume onto
  // an existing window" case never rotates, per design v3 §2, and so has no
  // fresh server to lose track of in the first place).
  it('followUp(): uses the server row re-read inside each isolation-lock span for resolvePaneId, not the server resolved before followUp() started', async () => {
    const unit = makeUnit({ id: 61, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ id: 61, serverName: 'local-server', unitId: 61, tmuxWindow: null });
    const { useCase, serverRepo, tmux } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
      projectServer: null,
    });
    let generation = 0;
    (serverRepo.findByName as ReturnType<typeof vi.fn>).mockImplementation(() => {
      generation += 1;
      return makeServer({ agentVersion: `gen-${generation}` });
    });

    await useCase.followUp(61, 61, 'please continue');

    const createSessionServer = (tmux.createSession as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const createWindowServer = (tmux.createWindow as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const resolvePaneIdServer = (tmux.resolvePaneId as ReturnType<typeof vi.fn>).mock.calls[0][0];

    expect(createSessionServer.agentVersion).toBeDefined();
    // createRotatedWindow's lock span re-read the server again for the real
    // task window — createWindow must see a STRICTLY NEWER row than
    // ensureSessionWithLock's.
    expect(createWindowServer.agentVersion).not.toBe(createSessionServer.agentVersion);
    // resolvePaneId (called right after createRotatedWindow returns) must
    // keep using that exact fresh row.
    expect(resolvePaneIdServer.agentVersion).toBe(createWindowServer.agentVersion);
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
    const { manifest } = resolveExecutionManifest(task, { unitRepo, projectRepo, projectServerRepo, serverRepo, projectSecretRepo: projectSecretRepo as any, unitTypeLoader: unitTypeLoader as any, sidekickLoader: sidekickLoader as any }, 'execute');
    task.executionApprovedFingerprintHash = hashExecutionManifest(manifest);

    await useCase.execute(10, 1);

    expect(tmux.createWindow).toHaveBeenCalled();
  });

  // Issue #87 review, forge/87-mirror follow-up, Important finding
  // (approval-boundary bypass): a task previously distributed from
  // repository A, then the project server re-pointed to repository B — a
  // FRESH execute() must re-hash against the CURRENT config (B), not the
  // recorded A, so the stale A-approval does not let B's code distribute
  // unapproved.
  it("execute(): a task approved while its project server distributed from repo A, then re-pointed to repo B, is BLOCKED again on the next execute() — the stale A-fingerprint does not authorize distributing B", async () => {
    const { resolveExecutionManifest, hashExecutionManifest } = await import('./ExecutionManifest.js');
    const repoA = { id: 1, url: 'https://github.com/acme/repo-a.git', provider: 'github' as const, owner: 'acme', repoName: 'repo-a', token: 'tok' };
    const repoB = { id: 2, url: 'https://github.com/acme/repo-b.git', provider: 'github' as const, owner: 'acme', repoName: 'repo-b', token: 'tok' };
    const task = makeTask({
      serverName: 'local-server',
      unitId: 10,
      inputTrust: 'untrusted',
      // This task's own distribution already ran against repo A.
      distributionRepositoryId: repoA.id,
    });
    const projectServerAtA = { workingDirectory: null, branch: null, tmuxSession: 'azito', inputPolicy: 'manual-approval' as const, distributeCode: true, distributionRepositoryId: repoA.id };
    const project = makeProject({ defaultUnitId: null, repositories: [{ id: repoA.id, name: 'A', url: repoA.url, provider: repoA.provider, owner: repoA.owner, repoName: repoA.repoName, hasToken: true }, { id: repoB.id, name: 'B', url: repoB.url, provider: repoB.provider, owner: repoB.owner, repoName: repoB.repoName, hasToken: true }] });

    // Approve the task the way GET .../execution-approval + POST
    // approve-execution actually would: hash the manifest AT EXECUTE TIME
    // ('execute' operationKind) against the config as it stood at approval
    // (still pointed at A).
    const { useCase: approvalUseCase } = buildUseCase({
      task, project, units: [makeUnit({ id: 10 })], projectServer: projectServerAtA, repository: repoA,
    });
    const { manifest: manifestAtApproval } = resolveExecutionManifest(task, {
      unitRepo: (approvalUseCase as any).unitRepo, projectRepo: (approvalUseCase as any).projectRepo,
      projectServerRepo: (approvalUseCase as any).projectServerRepo, serverRepo: (approvalUseCase as any).serverRepo,
      projectSecretRepo: (approvalUseCase as any).projectSecretRepo, unitTypeLoader: (approvalUseCase as any).unitTypeLoader,
      sidekickLoader: (approvalUseCase as any).sidekickLoader,
    }, 'execute');
    task.executionApprovedFingerprintHash = hashExecutionManifest(manifestAtApproval);

    // The project server is re-pointed at repo B before the next execute().
    const projectServerAtB = { ...projectServerAtA, distributionRepositoryId: repoB.id };
    const { useCase, taskRepo, tmux } = buildUseCase({
      task, project, units: [makeUnit({ id: 10 })], projectServer: projectServerAtB, repository: repoB,
    });

    await expect(useCase.execute(10, 1)).rejects.toThrow(/requires approval/);

    expect(tmux.createWindow).not.toHaveBeenCalled();
    expect(taskRepo.recordExecutionGateBlock).toHaveBeenCalledWith(1, { pendingOperation: 'execute', priorStatus: 'open', manifestHash: expect.any(String) });
  });

  // Companion to the test above: the SAME re-point must NOT block a
  // resumeStateMachine()/followUp() continuation of a task whose working
  // directory already holds repo A's code — the recorded repository stays
  // authoritative for a continuation, so approval is not spuriously
  // invalidated by a config change the continuation never acts on.
  it("resumeStateMachine(): the SAME project-server re-point (A -> B) that blocks a fresh execute() does NOT block resuming a task that already recorded repo A", async () => {
    const { resolveExecutionManifest, hashExecutionManifest } = await import('./ExecutionManifest.js');
    const repoA = { id: 1, url: 'https://github.com/acme/repo-a.git', provider: 'github' as const, owner: 'acme', repoName: 'repo-a', token: 'tok' };
    const repoB = { id: 2, url: 'https://github.com/acme/repo-b.git', provider: 'github' as const, owner: 'acme', repoName: 'repo-b', token: 'tok' };
    const task = makeTask({
      serverName: 'local-server',
      unitId: 10,
      tmuxWindow: 'task-1',
      currentPhase: null,
      inputTrust: 'untrusted',
      distributionRepositoryId: repoA.id,
    });
    const project = makeProject({ defaultUnitId: null, repositories: [{ id: repoA.id, name: 'A', url: repoA.url, provider: repoA.provider, owner: repoA.owner, repoName: repoA.repoName, hasToken: true }, { id: repoB.id, name: 'B', url: repoB.url, provider: repoB.provider, owner: repoB.owner, repoName: repoB.repoName, hasToken: true }] });
    // Project server now points at B — but the task's own working directory
    // still holds A's code, recorded on task.distributionRepositoryId.
    const projectServerAtB = { workingDirectory: null, branch: null, tmuxSession: 'azito', inputPolicy: 'manual-approval' as const, distributeCode: true, distributionRepositoryId: repoB.id };
    const { useCase, unitRepo, projectRepo, projectServerRepo, serverRepo, projectSecretRepo, unitTypeLoader, sidekickLoader } = buildUseCase({
      task, project, units: [makeUnit({ id: 10 })], projectServer: projectServerAtB, repository: repoB,
    });
    // Approve against the CONTINUATION resolution (recorded A) — the same
    // resolution resumeStateMachine()'s own gate re-check performs.
    const { manifest } = resolveExecutionManifest(task, {
      unitRepo, projectRepo, projectServerRepo, serverRepo,
      projectSecretRepo: projectSecretRepo as any, unitTypeLoader: unitTypeLoader as any, sidekickLoader: sidekickLoader as any,
    }, 'continuation');
    task.executionApprovedFingerprintHash = hashExecutionManifest(manifest);

    // Calls enforceExecutionGate() directly (not the full resumeStateMachine(),
    // which continues on into real worker-wait machinery this harness does
    // not mock) — this is the exact same gate call resumeStateMachine()
    // itself makes before doing anything else.
    expect(() => useCase.enforceExecutionGate(task, 10, 'resume')).not.toThrow();
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

// Issue #29 Step 3a: the 3-point AND gate for 'allow' (server isolation
// intent + a current doctor verification + scoped auth enabled), exercised
// end-to-end through ExecuteTaskUseCase.enforceExecutionGate() rather than
// just the pure resolveEffectiveInputPolicy() unit tests (ProjectServer.test.ts)
// — this also proves the degradation is actually wired to checkExecutionGate,
// not just computed and discarded.
describe('ExecuteTaskUseCase execution gate — "allow" policy 3-point AND gate (Issue #29 Step 3a)', () => {
  const isolatedVerifiedServer = () => makeServer({
    isolationIntent: true,
    isolationVerifiedAt: new Date().toISOString(),
    // A current isolationVerifiedAt must be paired with a passing
    // isolationReport (Issue #29 review Step 3a, Critical finding 1
    // follow-up defense-in-depth check in resolveEffectiveInputPolicy) —
    // real writers (SqliteServerRepository.updateIsolationVerification)
    // always set both atomically; this fixture mirrors that invariant.
    isolationReport: JSON.stringify({ kind: 'verification', verified: true, checks: [], probedAt: new Date().toISOString() }),
  });

  it('runs unattended (no approval required) when isolated, verified within TTL, and scoped auth is enabled', async () => {
    const task = makeTask({ serverName: 'local-server', unitId: 10, inputTrust: 'untrusted', executionApprovedFingerprintHash: null });
    const { useCase, tmux, logRepo } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [makeUnit({ id: 10 })],
      projectServer: { workingDirectory: null, branch: null, tmuxSession: 'azito', inputPolicy: 'allow' },
      server: isolatedVerifiedServer(),
      scopedAuthEnabled: true,
    });

    await useCase.execute(10, 1);

    expect(tmux.createWindow).toHaveBeenCalled();
    expect(logRepo.append).not.toHaveBeenCalledWith(1, 10, 'command', expect.objectContaining({ type: 'execution_policy_degraded' }));
  });

  it('degrades to manual-approval (reason "not_isolated") and blocks when the server has no isolation intent', async () => {
    const task = makeTask({ serverName: 'local-server', unitId: 10, inputTrust: 'untrusted', executionApprovedFingerprintHash: null });
    const { useCase, logRepo } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [makeUnit({ id: 10 })],
      projectServer: { workingDirectory: null, branch: null, tmuxSession: 'azito', inputPolicy: 'allow' },
      server: makeServer({ isolationIntent: false, isolationVerifiedAt: null }),
      scopedAuthEnabled: true,
    });

    await expect(useCase.execute(10, 1)).rejects.toThrow(/requires approval/);

    expect(logRepo.append).toHaveBeenCalledWith(1, 10, 'command', {
      type: 'execution_policy_degraded',
      requestedPolicy: 'allow',
      effectivePolicy: 'manual-approval',
      allowDegradedReason: 'not_isolated',
    });
  });

  it('degrades to manual-approval (reason "verification_missing") when isolated but never doctor-verified', async () => {
    const task = makeTask({ serverName: 'local-server', unitId: 10, inputTrust: 'untrusted', executionApprovedFingerprintHash: null });
    const { useCase, logRepo } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [makeUnit({ id: 10 })],
      projectServer: { workingDirectory: null, branch: null, tmuxSession: 'azito', inputPolicy: 'allow' },
      server: makeServer({ isolationIntent: true, isolationVerifiedAt: null }),
      scopedAuthEnabled: true,
    });

    await expect(useCase.execute(10, 1)).rejects.toThrow(/requires approval/);

    expect(logRepo.append).toHaveBeenCalledWith(1, 10, 'command', {
      type: 'execution_policy_degraded',
      requestedPolicy: 'allow',
      effectivePolicy: 'manual-approval',
      allowDegradedReason: 'verification_missing',
    });
  });

  it('degrades to manual-approval (reason "verification_expired") when the doctor verification is older than the TTL', async () => {
    const task = makeTask({ serverName: 'local-server', unitId: 10, inputTrust: 'untrusted', executionApprovedFingerprintHash: null });
    const { ISOLATION_VERIFICATION_TTL_MS } = await import('../../projects/ProjectServer.js');
    const { useCase, logRepo } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [makeUnit({ id: 10 })],
      projectServer: { workingDirectory: null, branch: null, tmuxSession: 'azito', inputPolicy: 'allow' },
      server: makeServer({ isolationIntent: true, isolationVerifiedAt: new Date(Date.now() - ISOLATION_VERIFICATION_TTL_MS - 1000).toISOString() }),
      scopedAuthEnabled: true,
    });

    await expect(useCase.execute(10, 1)).rejects.toThrow(/requires approval/);

    expect(logRepo.append).toHaveBeenCalledWith(1, 10, 'command', {
      type: 'execution_policy_degraded',
      requestedPolicy: 'allow',
      effectivePolicy: 'manual-approval',
      allowDegradedReason: 'verification_expired',
    });
  });

  it('degrades to manual-approval (reason "scoped_auth_disabled") when isolated and verified but scoped auth is off', async () => {
    const task = makeTask({ serverName: 'local-server', unitId: 10, inputTrust: 'untrusted', executionApprovedFingerprintHash: null });
    const { useCase, logRepo } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [makeUnit({ id: 10 })],
      projectServer: { workingDirectory: null, branch: null, tmuxSession: 'azito', inputPolicy: 'allow' },
      server: isolatedVerifiedServer(),
      scopedAuthEnabled: false,
    });

    await expect(useCase.execute(10, 1)).rejects.toThrow(/requires approval/);

    expect(logRepo.append).toHaveBeenCalledWith(1, 10, 'command', {
      type: 'execution_policy_degraded',
      requestedPolicy: 'allow',
      effectivePolicy: 'manual-approval',
      allowDegradedReason: 'scoped_auth_disabled',
    });
  });

  // Issue #29 Step 3a review, Important finding 2 (TOCTOU): the outer
  // enforceExecutionGate() check runs BEFORE this run ever queues for
  // serverIsolationMutex — if an isolation doctor run commits a failure
  // WHILE this call is queued for the lock, the outer 'allow' decision is
  // already stale by the time the lock is actually acquired.
  // reverifyGateInLock (wired as createRotatedWindowInLock's `preCheck`)
  // must catch this and abort BEFORE the window/task-token env is built,
  // not silently proceed on the outer decision.
  it('re-verifies the gate INSIDE the isolation lock and blocks execution when a doctor failure commits between the outer check and window creation', async () => {
    const task = makeTask({ serverName: 'local-server', unitId: 10, inputTrust: 'untrusted', executionApprovedFingerprintHash: null });
    const { useCase, serverRepo, logRepo, tmux } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [makeUnit({ id: 10 })],
      projectServer: { workingDirectory: null, branch: null, tmuxSession: 'azito', inputPolicy: 'allow' },
      server: isolatedVerifiedServer(),
      scopedAuthEnabled: true,
    });

    // Simulate a doctor run committing a failure (isolationVerifiedAt
    // cleared) after the outer enforceExecutionGate() check — and every
    // pre-lock read (the top-of-execute() server resolution, the
    // session-bootstrap lock's own refetch) — already read the passing row,
    // but before this run's window-creation lock actually re-checks the
    // gate: the first several findByName calls still see the passing row
    // (isolationVerifiedAt/isolationReport are excluded from
    // ServerIsolationLock's own snapshot-mismatch check, so switching mid-run
    // never trips ServerSnapshotMismatchError), then every call from the
    // window-creation lock's own refetch onward sees the now-degraded row.
    const degradedServer = makeServer({ isolationIntent: true, isolationVerifiedAt: null, isolationReport: null });
    let findByNameCalls = 0;
    (serverRepo.findByName as ReturnType<typeof vi.fn>).mockImplementation(() => {
      findByNameCalls += 1;
      return findByNameCalls <= 3 ? isolatedVerifiedServer() : degradedServer;
    });

    await expect(useCase.execute(10, 1)).rejects.toThrow(/requires approval/);

    // The window must never have been created — the whole point of running
    // this check as createRotatedWindowInLock's preCheck is that it fires
    // BEFORE any task-token/secret env is built or `create()` runs.
    expect(tmux.createWindow).not.toHaveBeenCalled();
    expect(logRepo.append).toHaveBeenCalledWith(1, 10, 'command', {
      type: 'execution_policy_degraded',
      requestedPolicy: 'allow',
      effectivePolicy: 'manual-approval',
      allowDegradedReason: 'verification_missing',
      reverifiedInLock: true,
    });
    expect(task.pendingOperation).toBe('execute');
    expect(task.status).toBe('pending_approval');
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
      updateStatusIfWindowMatches: vi.fn((_id: number, expectedWindowName: string, status: Task['status']) => {
        if (task.tmuxWindow !== expectedWindowName && task.tmuxWindow !== null) return false;
        task.status = status;
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
      updateRepositoryToken: vi.fn(),
      removeRepository: vi.fn(),
      findRepositoryCredentialsByIds: vi.fn(() => []),
    };
    const projectServerRepo: IProjectServerRepository = {
      findByProject: vi.fn(() => [{ projectId: 1, serverName: 'local-server', workingDirectory: '/work', branch: null, tmuxSession: 'azito', inputPolicy: 'manual-approval' as const, distributeCode: false, distributionRepositoryId: null }]),
      findByServer: vi.fn(() => []),
      find: vi.fn(() => ({ projectId: 1, serverName: 'local-server', workingDirectory: '/work', branch: null, tmuxSession: 'azito', inputPolicy: 'manual-approval' as const, distributeCode: false, distributionRepositoryId: null })),
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
      true,
      async () => [],
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

    // Issue #87 seventh-pass review fix: the worktree_path_rejected branch
    // passes worktreePath/worktreeBranch-clearing extra fields through to
    // the SAME generation-guarded updateStatusIfWindowMatches() call (not a
    // second unconditional taskRepo.update()), so this call now carries a
    // 5th argument that clears both fields atomically with the status write.
    expect(taskRepo.updateStatusIfWindowMatches).toHaveBeenCalledWith(4, 'w1', 'failed', 101, {
      worktreePath: null,
      worktreeBranch: null,
    });
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
    // Issue #87 seventh-pass review fix: worktreePath/worktreeBranch are now
    // cleared inside the SAME generation-guarded updateStatusIfWindowMatches()
    // call as the status write (a stale rollback that fails the window guard
    // must not clear these fields either) — no second unconditional
    // taskRepo.update() call exists anymore for this path.
    expect(taskRepo.updateStatusIfWindowMatches).toHaveBeenCalledWith(6, 'w1', 'failed', 101, {
      worktreePath: null,
      worktreeBranch: null,
    });
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

  // Issue #29 review, 14th pass, Important finding 1: the per-server
  // isolation lock + snapshot check now wraps confirmOldWindowGone (the old
  // window kill) as well as createRotatedWindow, not just the latter. Before
  // this fix, execute() killed the leftover window using whatever `server`
  // row it had resolved before ever queuing for the lock, and only reached
  // the lock+snapshot-check afterwards inside createRotatedWindow — so a
  // mismatch (e.g. a concurrent isolation PUT committing mid-flight) was
  // discovered only AFTER the old window was already dead, leaving
  // task.tmuxWindow pointing at a killed window with no replacement ever
  // created. This test asserts the corrected ordering: the mismatch aborts
  // BEFORE killWindow is ever called.
  it('execute(): aborts BEFORE killing the leftover window when the row read inside the lock disagrees with the session-bootstrap row on a security field', async () => {
    const unit = makeUnit({ id: 36, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ id: 46, serverName: 'local-server', unitId: 36, tmuxWindow: 'old-window' });
    const { useCase, tmux, paneEnvService, windowRepo, serverRepo } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
      projectServer: null,
    });
    tmux.listSessions.mockResolvedValue([
      { name: 'azito', windows: [{ name: 'old-window', index: 5 }] },
    ]);
    // First findByName call (ensureSessionWithLock's session-bootstrap span)
    // returns a non-isolated row — execute() reassigns its own `server`
    // variable to this row and carries it into the kill+create lock span.
    // Second call (the kill+create span itself) returns a row that
    // disagrees on isolationIntent, simulating a `PUT /api/servers/:name`
    // isolation transition committing in the gap between the two lock
    // spans.
    let call = 0;
    (serverRepo.findByName as ReturnType<typeof vi.fn>).mockImplementation(() => {
      call += 1;
      return makeServer({ isolationIntent: call >= 2 });
    });

    await expect(useCase.execute(36, 46)).rejects.toThrow(/設定が実行準備中に変更された/);

    expect(tmux.killWindow).not.toHaveBeenCalled();
    expect(paneEnvService.buildEnvForNewWindow).not.toHaveBeenCalled();
    expect(tmux.createWindow).not.toHaveBeenCalled();
    expect(windowRepo.add).not.toHaveBeenCalled();
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

  // Issue #87 third-party review, Important finding 1: the status write in
  // rollbackWindowAfterPostCreationFailure() used to be an unconditional
  // `update(taskId, { status: 'failed' })`, so it stomped a newer window
  // generation's status the same way the (already-fixed) unconditional
  // tmuxWindow null-out above did. Same race shape as the first test in this
  // describe block, but asserting the STATUS side this time.
  it('execute(): a worktree-creation failure does not mark the task failed when a concurrent execution has already advanced it to in_progress on a newer window generation', async () => {
    const unit = makeUnit({ id: 72, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ id: 72, serverName: 'local-server', unitId: 72 });
    const { useCase, taskRepo, paneEnvService, worktreeServiceFactory } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
      projectServer: { workingDirectory: allowedRoot, branch: null, tmuxSession: 'azito' },
    });
    worktreeServiceFactory.create.mockReturnValue({
      // Simulates a concurrent execute()/followUp() for the SAME task
      // acquiring the lock, creating window 'w2', and persisting BOTH its
      // own tmuxWindow AND status: 'in_progress' — exactly what
      // ExecuteTaskUseCase.execute() itself does at window-creation time
      // (see the real `this.taskRepo.update(taskId, { status: 'in_progress',
      // tmuxWindow: newWindowName })` call) — before THIS call's worktree
      // creation fails and tries to roll back its own ('w1') generation.
      create: vi.fn(async () => {
        task.tmuxWindow = 'w2';
        task.status = 'in_progress' as Task['status'];
        throw new Error('worktree failed');
      }),
    });

    await expect(useCase.execute(72, 72)).rejects.toThrow(/Worktree creation failed/);

    // The rollback attempted to fail ITS OWN generation ('w1')...
    expect(taskRepo.updateStatusIfWindowMatches).toHaveBeenCalledWith(72, 'w1', 'failed', 101);
    // ...but since the row had already moved on to 'w2', the guarded write
    // must be a no-op — the newer generation's in-flight status survives.
    expect(task.status).toBe('in_progress');
    expect(task.tmuxWindow).toBe('w2');
    expect(paneEnvService.revokeGeneration).toHaveBeenCalledWith(101, 'worktree_creation_failed_rollback');
  });

  it('execute(): a worktree-creation failure DOES mark the task failed when no concurrent execution has replaced its window generation', async () => {
    const unit = makeUnit({ id: 73, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ id: 73, serverName: 'local-server', unitId: 73 });
    const { useCase, taskRepo, paneEnvService, worktreeServiceFactory } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
      projectServer: { workingDirectory: allowedRoot, branch: null, tmuxSession: 'azito' },
    });
    worktreeServiceFactory.create.mockReturnValue({
      // The real `this.taskRepo.update(taskId, { status: 'in_progress',
      // tmuxWindow: newWindowName })` call at window-creation time (see the
      // race test above) is what actually persists `tmuxWindow: 'w1'` on the
      // task row — this harness's `update` mock is a bare `vi.fn()` with no
      // side effect, so the same persistence is modeled here explicitly, to
      // isolate this test to ONLY the "no concurrent generation change"
      // case (unlike the race test, nothing else touches `task.tmuxWindow`
      // before the rollback runs).
      create: vi.fn(async () => {
        task.tmuxWindow = 'w1';
        throw new Error('worktree failed');
      }),
    });

    await expect(useCase.execute(73, 73)).rejects.toThrow(/Worktree creation failed/);

    expect(taskRepo.updateStatusIfWindowMatches).toHaveBeenCalledWith(73, 'w1', 'failed', 101);
    expect(task.status).toBe('failed');
    expect(paneEnvService.revokeGeneration).toHaveBeenCalledWith(101, 'worktree_creation_failed_rollback');
  });

  // Issue #87 third-party review, second pass: the previous fix guarded the
  // status write with `tmux_window = expectedWindowName`, which treated ANY
  // mismatch — including tmuxWindow having been cleared to NULL — as "a
  // newer generation took over" and skipped the write. But the ordinary
  // window-destruction path (e.g. TaskWindowDestruction) can clear THIS
  // SAME generation's tmuxWindow to NULL while this call's own
  // distribution/worktree-creation await is still in flight, before that
  // await goes on to fail. Unlike the 'w2' race above, no concurrent
  // execution ever ran here — task.status stays whatever it was
  // (in_progress) the whole time. The fix must still record `failed` in
  // this case, or the task is stuck in_progress with no window forever.
  it('execute(): a worktree-creation failure DOES mark the task failed when tmuxWindow was cleared to NULL by ordinary window destruction mid-await (not replaced by a newer generation)', async () => {
    const unit = makeUnit({ id: 74, workerType: 'claude', workerModel: 'opus' });
    const task = makeTask({ id: 74, serverName: 'local-server', unitId: 74 });
    const { useCase, taskRepo, paneEnvService, worktreeServiceFactory } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null }),
      units: [unit],
      projectServer: { workingDirectory: allowedRoot, branch: null, tmuxSession: 'azito' },
    });
    worktreeServiceFactory.create.mockReturnValue({
      // Simulates the ordinary window-destruction path clearing THIS SAME
      // generation's tmuxWindow to NULL (mirrors clearTmuxWindowIfMatches's
      // own NULL-out) while this worktree-creation await is still pending,
      // before it fails. No concurrent execution's tmuxWindow or status
      // is written here — task.status is never touched before the
      // rollback runs.
      create: vi.fn(async () => {
        task.tmuxWindow = null;
        throw new Error('worktree failed');
      }),
    });

    await expect(useCase.execute(74, 74)).rejects.toThrow(/Worktree creation failed/);

    expect(taskRepo.updateStatusIfWindowMatches).toHaveBeenCalledWith(74, 'w1', 'failed', 101);
    expect(task.status).toBe('failed');
    expect(paneEnvService.revokeGeneration).toHaveBeenCalledWith(101, 'worktree_creation_failed_rollback');
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
      updateRepositoryToken: vi.fn(),
      removeRepository: vi.fn(),
      findRepositoryCredentialsByIds: vi.fn(() => []),
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
    }, 'execute');
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
      true,
      async () => [],
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
    sleeping: false,
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

// ─── Shared fixtures for the two fetch-distribution describe blocks below
// (gate behavior + failure-rollback behavior) ───
//
// Reviewer note (Issue #87 third-party review, Minor finding 2): these two
// describe blocks used to each define their own copy of `repository`,
// `projectWithRepository()`, and `buildDistributionGateHarness()` — a future
// fixture change (e.g. a new required ServerConfig/ProjectDetail field) could
// then silently drift between the gate tests and the failure tests, each
// exercising a different environment without either describe block noticing.
// Lifted out here so both blocks share exactly one harness.
const fetchDistributionRepository = {
  id: 5,
  url: 'https://github.com/acme/widget.git',
  provider: 'github' as const,
  owner: 'acme',
  repoName: 'widget',
  token: 'tok123',
};

function projectWithFetchDistributionRepository(): ProjectDetail {
  return makeProject({
    defaultUnitId: null,
    repositories: [
      { id: 5, name: null, url: fetchDistributionRepository.url, provider: 'github', owner: 'acme', repoName: 'widget', hasToken: true },
    ],
  });
}

function buildDistributionGateHarness(opts: {
  server: ServerConfig;
  distributeCode: boolean;
  /** Overrides the project returned by projectRepo.findById — for the fail-fast-on-missing-repository test. */
  project?: ProjectDetail;
  /** Overrides the repository row returned by projectRepo.findRepositoryById — for the fail-fast-on-missing-token/bad-identity tests. */
  repository?: { id: number; url: string; provider: 'github' | 'gitlab'; owner: string | null; repoName: string | null; token: string | null };
  /** Lets a caller make distribute() fail (or throw) instead of the default success — for the failed-distribution rollback test. */
  distributeResult?: { status: 'distributed' | 'already_current' | 'failed'; sha?: string; bundleType?: 'full' | 'incremental'; error?: string; localBranchSynced?: boolean };
  /** Overrides task.workingDirectory (default '/srv/repo') — set to null for the "distribution required but no workingDir" fail-fast tests (Important finding 2). */
  taskWorkingDirectory?: string | null;
  /** Overrides task.branch (default null) — for the localBranchSynced fail-fast tests (Important finding 1). */
  taskBranch?: string | null;
  /** Overrides task.baseBranch (default null, which resolveBaseBranch falls back to 'main' for). */
  taskBaseBranch?: string | null;
  /** Issue #87 review, 6th pass, Important finding 1: set false to construct the
   * use case WITHOUT a fetchDistributionService (mirrors an unwired hub) — for the
   * "required but not wired" fail-fast test. Defaults true (normal gate/rollback tests). */
  serviceWired?: boolean;
  /** Overrides the project server's `distributionRepositoryId` (default: 5, matching fetchDistributionRepository.id — a normal, resolvable distribution target). Set to `null` for the "no distribution target configured" fail-fast tests. */
  distributionRepositoryId?: number | null;
  /** Overrides task.distributionRepositoryId (default null) — set to model a PRIOR run's recorded target, for the "prerequisite failure preserves the previous record" tests (Issue #87 review follow-up, second round, Important finding 1). */
  taskDistributionRepositoryId?: number | null;
  /** Issue #87 review (forge/87-mirror follow-up), Important finding 3: threaded through to buildUseCase's `distributionStateRepo` — see its own doc comment. Defaults null (not wired). */
  distributionStateRepo?: { find: ReturnType<typeof vi.fn> } | null;
}) {
  const unit = makeUnit({ id: 10, workerType: 'claude', workerModel: 'opus' });
  // task.workingDirectory (not projectServer.workingDirectory) supplies
  // `workingDir` here deliberately: a non-null projectServer.workingDirectory
  // would set `allowedRoot`, which forces ExecuteTaskUseCase through
  // assertDirectoryContained's real filesystem/transport-backed path
  // verification (Issue #27 containment) — irrelevant plumbing for this
  // gate's own concern (whether distribute() got called) and not worth
  // faking a transport or a real worktree directory for.
  const task = makeTask({
    id: 1,
    serverName: opts.server.name,
    unitId: 10,
    workingDirectory: ('taskWorkingDirectory' in opts ? opts.taskWorkingDirectory : '/srv/repo') as string | null,
    branch: (opts.taskBranch ?? null) as string | null,
    baseBranch: (opts.taskBaseBranch ?? null) as string | null,
    distributionRepositoryId: (opts.taskDistributionRepositoryId ?? null) as number | null,
  });
  // Issue #87 review (forge/87-mirror follow-up), Important finding 2
  // (third round): the record-write callback now fires from INSIDE
  // distribute() (threaded through as `onBeforeWorkingDirChange`), not by
  // performDistribution() before distribute() is even called — see
  // DistributionHelper.ts's `onBeforeDistribute` doc comment. This fake
  // must call it too, mirroring the real FetchDistributionService, or every
  // test below asserting `taskRepo.update({ distributionRepositoryId })`
  // was written would falsely fail on a "distributed"/"already_current"
  // result. Deliberately NOT called for a `distributeResult` explicitly
  // modeling a failure the real service would hit BEFORE touching the
  // working directory (`status: 'failed'`) — see the "prerequisite failure
  // preserves the previous record" tests, which rely on this callback never
  // firing for that case.
  const fetchDistributionService = {
    distribute: vi.fn(async (params: { onBeforeWorkingDirChange?: () => void }) => {
      const result = opts.distributeResult ?? { status: 'distributed' as const, sha: 'abc123', bundleType: 'full' as const, localBranchSynced: true };
      if (result.status !== 'failed') params.onBeforeWorkingDirChange?.();
      return result;
    }),
  };
  const harness = buildUseCase({
    task,
    project: opts.project ?? projectWithFetchDistributionRepository(),
    units: [unit],
    projectServer: { workingDirectory: null, branch: null, tmuxSession: 'azito', distributeCode: opts.distributeCode, distributionRepositoryId: 'distributionRepositoryId' in opts ? opts.distributionRepositoryId ?? null : 5 },
    server: opts.server,
    repository: 'repository' in opts ? opts.repository : fetchDistributionRepository,
    distributionStateRepo: opts.distributionStateRepo ?? null,
    ...(opts.serviceWired === false ? {} : { fetchDistributionService }),
  });
  harness.worktreeServiceFactory.create.mockReturnValue({
    create: vi.fn(async () => ({ path: '/srv/repo/.worktrees/task-1', branch: 'task/1-slug' })),
  });
  return { ...harness, fetchDistributionService };
}

describe('ExecuteTaskUseCase fetch-distribution gate (Issue #87 Phase 2: generalized beyond isolated servers via project_servers.distribute_code)', () => {
  it('distributes for an isolated server even when distribute_code is off (isolation makes distribution mandatory, not opt-in)', async () => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    const { useCase, fetchDistributionService } = buildDistributionGateHarness({ server, distributeCode: false });

    await useCase.execute(10, 1);

    expect(fetchDistributionService.distribute).toHaveBeenCalledTimes(1);
  });

  it('distributes for a non-isolated agent/ssh server when the project has opted in via distribute_code', async () => {
    const server = makeServer({ name: 'srv-agent', type: 'agent', isolationIntent: false, sshHost: 'agent-host' });
    const { useCase, fetchDistributionService } = buildDistributionGateHarness({ server, distributeCode: true });

    await useCase.execute(10, 1);

    expect(fetchDistributionService.distribute).toHaveBeenCalledTimes(1);
  });

  it('does not distribute for a non-isolated server when distribute_code is off', async () => {
    const server = makeServer({ name: 'srv-agent', type: 'agent', isolationIntent: false });
    const { useCase, fetchDistributionService } = buildDistributionGateHarness({ server, distributeCode: false });

    await useCase.execute(10, 1);

    expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
  });

  it('never distributes to a local server, even when distribute_code is on (that server IS the hub)', async () => {
    const server = makeServer({ name: 'local-server', type: 'local', isolationIntent: false });
    const { useCase, fetchDistributionService } = buildDistributionGateHarness({ server, distributeCode: true });

    await useCase.execute(10, 1);

    expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
  });
});

// Issue #87 16th-round review, Important finding 2: the pre-lock projectServer
// (resolved by enforceExecutionGate, before the resource guard/window
// creation/runExclusiveForTask even start) must never be what decides whether
// distribution runs — only the row the in-lock gate reverification
// (reverifyGateInLock, running as createRotatedWindowInLock's preCheck) just
// re-resolved and validated against may decide that, exactly like the gate
// decision itself already does.
describe('ExecuteTaskUseCase distribution decides against the in-lock (not pre-lock) projectServer snapshot (Issue #87 16th-round review, Important finding 2)', () => {
  // projectServerRepo.find() is called 3 times over one execute() run: (1)
  // resolveExecutionEnv's resolveTmuxSession, (2) enforceExecutionGate's
  // pre-lock resolveExecutionManifest, (3) reverifyGateInLock's in-lock
  // resolveExecutionManifest. `distributeCodeFromCall3` flips ONLY from the
  // 3rd call onward, so calls 1-2 always see the OTHER value — modeling a
  // distribute_code toggle landing in the window between the pre-lock gate
  // check and the in-lock reverification.
  function toggleProjectServerFind(
    projectServerRepo: ReturnType<typeof buildDistributionGateHarness>['projectServerRepo'],
    serverName: string,
    distributeCodeFromCall3: boolean,
  ) {
    let calls = 0;
    projectServerRepo.find = vi.fn(() => {
      calls += 1;
      const distributeCode = calls >= 3 ? distributeCodeFromCall3 : !distributeCodeFromCall3;
      return { projectId: 1, serverName, workingDirectory: null, branch: null, tmuxSession: 'azito', inputPolicy: 'manual-approval' as const, distributeCode, distributionRepositoryId: 5 };
    });
  }

  it('distributes when the pre-lock row said false but the in-lock row says true', async () => {
    const server = makeServer({ name: 'srv-agent', type: 'agent', isolationIntent: false });
    const harness = buildDistributionGateHarness({ server, distributeCode: false });
    toggleProjectServerFind(harness.projectServerRepo, server.name, true);

    await harness.useCase.execute(10, 1);

    expect(harness.fetchDistributionService.distribute).toHaveBeenCalledTimes(1);
  });

  it('does NOT distribute when the pre-lock row said true but the in-lock row says false', async () => {
    const server = makeServer({ name: 'srv-agent', type: 'agent', isolationIntent: false });
    const harness = buildDistributionGateHarness({ server, distributeCode: true });
    toggleProjectServerFind(harness.projectServerRepo, server.name, false);

    await harness.useCase.execute(10, 1);

    expect(harness.fetchDistributionService.distribute).not.toHaveBeenCalled();
  });
});

// Issue #87 review (forge/87-mirror follow-up), Minor finding 3: the final
// PR reference (collected in execute()'s post-run async tail) must reuse the
// SAME `distributionRepoEntry` already resolved against the fully-locked
// `lockedProject`/`lockedProjectServer` snapshot — not re-derive it by
// mixing `lockedProjectServer` with the pre-lock `project` snapshot (from
// before `reverifyGateInLock` ran). Mirrors the "16th-round review" harness
// above: `projectRepo.findById` returns a DIFFERENT project snapshot for the
// pre-lock calls (repository A only) than the in-lock reverification call
// (repository A AND B) — modeling repository B being registered on the
// project in the window between the pre-lock gate check and the in-lock
// reverification, with `distributionRepositoryId` already pointing at B.
describe('ExecuteTaskUseCase final PR reference reuses the locked distributionRepoEntry, not the pre-lock project snapshot (Issue #87 review, forge/87-mirror follow-up, Minor finding 3)', () => {
  const repoA = { id: 1, name: null, url: 'https://github.com/acme/repo-a.git', provider: 'github' as const, owner: 'acme', repoName: 'repo-a', hasToken: true };
  const repoB = { id: 2, name: null, url: 'https://github.com/acme/repo-b.git', provider: 'github' as const, owner: 'acme', repoName: 'repo-b', hasToken: true };
  const repoAWithToken = { ...repoA, token: 'tok-a' };
  const repoBWithToken = { ...repoB, token: 'tok-b' };

  it('resolves the final PR reference against the locked repository (B), even though the pre-lock project snapshot only had repository A registered', async () => {
    const server = makeServer({ name: 'agent-1', type: 'agent', isolationIntent: false });
    const task = makeTask({
      id: 1, projectId: 1, unitId: 10, serverName: 'agent-1',
      workingDirectory: '/work', worktreePath: null, baseBranch: null,
    });
    const unit = makeUnit({ id: 10, workerType: 'claude', workerModel: 'opus', workerExecutionMode: 'tmux-pipe' });

    const projectPreLock = makeProject({ defaultUnitId: null, repositories: [repoA] });
    const projectInLock = makeProject({ defaultUnitId: null, repositories: [repoA, repoB] });

    const harness = buildUseCase({
      task,
      project: projectPreLock,
      units: [unit],
      projectServer: { workingDirectory: null, branch: null, tmuxSession: 'azito', distributeCode: true, distributionRepositoryId: repoB.id },
      server,
      fetchDistributionService: { distribute: vi.fn(async () => ({ status: 'distributed' as const, sha: 'abc123', bundleType: 'full' as const, localBranchSynced: true })) },
    } as any);

    let findByIdCalls = 0;
    harness.projectRepo.findById = vi.fn(() => {
      findByIdCalls += 1;
      // Calls 1-2: resolveExecutionEnv + enforceExecutionGate (pre-lock,
      // repository A only). Call 3+: reverifyGateInLock (in-lock,
      // repository B now present) — the snapshot `lockedProject` must use.
      return findByIdCalls <= 2 ? projectPreLock : projectInLock;
    });
    harness.projectRepo.findRepositoryById = vi.fn((id: number) => (id === repoB.id ? repoBWithToken : repoAWithToken));
    harness.worktreeServiceFactory.create.mockReturnValue({
      create: vi.fn(async () => ({ path: '/srv/repo/.worktrees/task-1', branch: 'task/1-slug' })),
    });
    harness.tmux.execCommand = vi.fn(async (_server: unknown, cmd: string) => {
      if (cmd.includes('branch --show-current')) return { stdout: 'task/1-slug\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });
    (harness.useCase as any).phaseLoopRunner.stateMachineLoop = vi.fn(async () => {});

    await harness.useCase.execute(10, 1);
    for (let i = 0; i < 30; i++) await Promise.resolve();

    expect(harness.gitProvider.findPullRequestByBranch).toHaveBeenCalledWith(repoBWithToken, 'task/1-slug');
    expect(harness.gitProvider.findPullRequestByBranch).not.toHaveBeenCalledWith(repoAWithToken, expect.anything());
  });
});

describe('ExecuteTaskUseCase fetch-distribution failure handling (Issue #87 third-party review)', () => {
  // 指摘1: 配信が失敗したとき、タスク status が failed になり、ウィンドウ kill・
  // トークン revoke・tmuxWindow クリアが行われること。
  it('rolls back the just-created window/token and marks the task failed when distribute() reports status "failed"', async () => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    const { useCase, taskRepo, tmux, paneEnvService, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: false,
      distributeResult: { status: 'failed', error: 'network unreachable' },
    });

    await expect(useCase.execute(10, 1)).rejects.toThrow(/Fetch distribution failed/);

    expect(fetchDistributionService.distribute).toHaveBeenCalledTimes(1);
    expect(taskRepo.updateStatusIfWindowMatches).toHaveBeenCalledWith(1, 'w1', 'failed', 101);
    expect(tmux.killWindow).toHaveBeenCalledWith(expect.anything(), 'azito:w1');
    expect(paneEnvService.revokeGeneration).toHaveBeenCalledWith(101, 'fetch_distribution_failed_rollback');
    expect(taskRepo.clearTmuxWindowIfMatches).toHaveBeenCalledWith(1, 'w1');
  });

  // 指摘2: 配信が要求されているのに前提条件が欠けている場合は fail fast すること
  // （配信対象リポジトリ未設定 / 対象リポジトリが消失 / リポジトリにトークン無し /
  // identity 解決失敗のそれぞれで、同じロールバック経路を通る）。isolationIntent
  // 経路と distributeCode 経路の両方で確認する。
  it('fails fast (does not distribute) and rolls back the window when distribution is required but no distribution target repository is configured', async () => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    const { useCase, taskRepo, tmux, paneEnvService, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: false,
      distributionRepositoryId: null,
    });

    await expect(useCase.execute(10, 1)).rejects.toThrow(/no distribution target repository is configured/);

    expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
    expect(taskRepo.updateStatusIfWindowMatches).toHaveBeenCalledWith(1, 'w1', 'failed', 101);
    expect(tmux.killWindow).toHaveBeenCalledWith(expect.anything(), 'azito:w1');
    expect(paneEnvService.revokeGeneration).toHaveBeenCalledWith(101, 'fetch_distribution_prereq_failed_rollback');
  });

  it('fails fast and rolls back the window when the configured distribution target repository no longer exists on the project', async () => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    const { useCase, taskRepo, tmux, paneEnvService, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: false,
      project: makeProject({ defaultUnitId: null, repositories: [] }),
    });

    await expect(useCase.execute(10, 1)).rejects.toThrow(/configured distribution target repository no longer exists/);

    expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
    expect(taskRepo.updateStatusIfWindowMatches).toHaveBeenCalledWith(1, 'w1', 'failed', 101);
    expect(tmux.killWindow).toHaveBeenCalledWith(expect.anything(), 'azito:w1');
    expect(paneEnvService.revokeGeneration).toHaveBeenCalledWith(101, 'fetch_distribution_prereq_failed_rollback');
  });

  it('fails fast and rolls back the window when distribution is required (distribute_code opt-in on a non-isolated server) but the repository has no token', async () => {
    const server = makeServer({ name: 'srv-agent', type: 'agent', isolationIntent: false, sshHost: 'agent-host' });
    const { useCase, taskRepo, tmux, paneEnvService, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: true,
      repository: { ...fetchDistributionRepository, token: null },
    });

    await expect(useCase.execute(10, 1)).rejects.toThrow(/no token configured/);

    expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
    expect(taskRepo.updateStatusIfWindowMatches).toHaveBeenCalledWith(1, 'w1', 'failed', 101);
    expect(tmux.killWindow).toHaveBeenCalledWith(expect.anything(), 'azito:w1');
    expect(paneEnvService.revokeGeneration).toHaveBeenCalledWith(101, 'fetch_distribution_prereq_failed_rollback');
  });

  it('fails fast and rolls back the window when the repository URL cannot be resolved to a canonical identity', async () => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    const { useCase, taskRepo, tmux, paneEnvService, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: false,
      // http:// (plaintext) is rejected by normalizeRepositoryUrlToHttps —
      // resolveCanonicalRepositoryIdentity returns { ok: false }.
      repository: { ...fetchDistributionRepository, url: 'http://github.com/acme/widget.git' },
    });

    await expect(useCase.execute(10, 1)).rejects.toThrow(/could not be normalized/);

    expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
    expect(taskRepo.updateStatusIfWindowMatches).toHaveBeenCalledWith(1, 'w1', 'failed', 101);
    expect(tmux.killWindow).toHaveBeenCalledWith(expect.anything(), 'azito:w1');
    expect(paneEnvService.revokeGeneration).toHaveBeenCalledWith(101, 'fetch_distribution_prereq_failed_rollback');
  });

  it('does not fail fast when distribution is not requested, even with no repository/token configured (isolationIntent off, distribute_code off)', async () => {
    const server = makeServer({ name: 'srv-agent', type: 'agent', isolationIntent: false });
    const { useCase, taskRepo, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: false,
      project: makeProject({ defaultUnitId: null, repositories: [] }),
    });

    await useCase.execute(10, 1);

    expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
    expect(taskRepo.updateStatusIfWindowMatches).not.toHaveBeenCalled();
  });
});

describe('ExecuteTaskUseCase fetch-distribution stale-local-branch fail-fast (Issue #87 review, forge/87-mirror follow-up, Important finding 1)', () => {
  // RemoteWorktreeService.create() only takes the "reuse existing local
  // branch" path (bypassing baseBranch resolution) when task.branch is set
  // AND names an existing local branch. That path is only actually reached
  // with STALE content when task.branch equals the distributed baseBranch
  // (here: 'main', from project.defaultBranch) — so only that combination,
  // together with distribute() reporting localBranchSynced: false, must
  // fail fast.
  it('fails fast when localBranchSynced is false and task.branch equals the distributed baseBranch', async () => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    const { useCase, taskRepo, tmux, paneEnvService, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: false,
      taskBranch: 'main',
      distributeResult: { status: 'distributed', sha: 'abc123', bundleType: 'full', localBranchSynced: false },
    });

    await expect(useCase.execute(10, 1)).rejects.toThrow(/could not be updated to the distributed content/);

    expect(fetchDistributionService.distribute).toHaveBeenCalledTimes(1);
    expect(taskRepo.updateStatusIfWindowMatches).toHaveBeenCalledWith(1, 'w1', 'failed', 101);
    expect(tmux.killWindow).toHaveBeenCalledWith(expect.anything(), 'azito:w1');
    expect(paneEnvService.revokeGeneration).toHaveBeenCalledWith(101, 'fetch_distribution_stale_local_branch_rollback');
  });

  // Issue #87 third-party review, 9th round, Important finding 1: the API
  // boundary (tasks/routes.ts validateGitFields) now rejects newly-submitted
  // `refs/heads/...` branch names, but this guard must ALSO normalize before
  // comparing (defense in depth) so a fully-qualified ref that reaches it
  // through some other path — pre-existing data, a call site the boundary
  // doesn't cover — cannot evade the fail-fast the same way the raw
  // `task.branch === baseBranch` string comparison used to.
  it('fails fast when localBranchSynced is false and task.branch is the fully-qualified ref form of the distributed baseBranch (refs/heads/main vs main)', async () => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    const { useCase, taskRepo, tmux, paneEnvService, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: false,
      taskBranch: 'refs/heads/main',
      distributeResult: { status: 'distributed', sha: 'abc123', bundleType: 'full', localBranchSynced: false },
    });

    await expect(useCase.execute(10, 1)).rejects.toThrow(/could not be updated to the distributed content/);

    expect(fetchDistributionService.distribute).toHaveBeenCalledTimes(1);
    expect(taskRepo.updateStatusIfWindowMatches).toHaveBeenCalledWith(1, 'w1', 'failed', 101);
    expect(tmux.killWindow).toHaveBeenCalledWith(expect.anything(), 'azito:w1');
    expect(paneEnvService.revokeGeneration).toHaveBeenCalledWith(101, 'fetch_distribution_stale_local_branch_rollback');
  });

  it('does NOT fail fast when localBranchSynced is false but task.branch names a different (user work) branch', async () => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    const { useCase, taskRepo, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: false,
      taskBranch: 'feature/my-work',
      distributeResult: { status: 'distributed', sha: 'abc123', bundleType: 'full', localBranchSynced: false },
    });

    await useCase.execute(10, 1);

    expect(fetchDistributionService.distribute).toHaveBeenCalledTimes(1);
    expect(taskRepo.updateStatusIfWindowMatches).not.toHaveBeenCalled();
  });

  it('does NOT fail fast when localBranchSynced is false and task.branch is unset', async () => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    const { useCase, taskRepo, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: false,
      distributeResult: { status: 'distributed', sha: 'abc123', bundleType: 'full', localBranchSynced: false },
    });

    await useCase.execute(10, 1);

    expect(fetchDistributionService.distribute).toHaveBeenCalledTimes(1);
    expect(taskRepo.updateStatusIfWindowMatches).not.toHaveBeenCalled();
  });

  it('does NOT fail fast when localBranchSynced is true, even when task.branch equals the distributed baseBranch', async () => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    const { useCase, taskRepo, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: false,
      taskBranch: 'main',
      distributeResult: { status: 'distributed', sha: 'abc123', bundleType: 'full', localBranchSynced: true },
    });

    await useCase.execute(10, 1);

    expect(fetchDistributionService.distribute).toHaveBeenCalledTimes(1);
    expect(taskRepo.updateStatusIfWindowMatches).not.toHaveBeenCalled();
  });
});

describe('ExecuteTaskUseCase fetch-distribution required but no workingDir fail-fast (Issue #87 review, forge/87-mirror follow-up, Important finding 2)', () => {
  it('fails fast when distribution is required by server isolation intent but no working directory is configured', async () => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    const { useCase, taskRepo, tmux, paneEnvService, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: false,
      taskWorkingDirectory: null,
    });

    await expect(useCase.execute(10, 1)).rejects.toThrow(/no working directory is configured/);

    expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
    expect(taskRepo.updateStatusIfWindowMatches).toHaveBeenCalledWith(1, 'w1', 'failed', 101);
    expect(tmux.killWindow).toHaveBeenCalledWith(expect.anything(), 'azito:w1');
    expect(paneEnvService.revokeGeneration).toHaveBeenCalledWith(101, 'fetch_distribution_prereq_failed_rollback');
  });

  it('fails fast when distribution is required by project distribute_code opt-in but no working directory is configured', async () => {
    const server = makeServer({ name: 'srv-agent', type: 'agent', isolationIntent: false, sshHost: 'agent-host' });
    const { useCase, taskRepo, tmux, paneEnvService, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: true,
      taskWorkingDirectory: null,
    });

    await expect(useCase.execute(10, 1)).rejects.toThrow(/no working directory is configured/);

    expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
    expect(taskRepo.updateStatusIfWindowMatches).toHaveBeenCalledWith(1, 'w1', 'failed', 101);
    expect(tmux.killWindow).toHaveBeenCalledWith(expect.anything(), 'azito:w1');
    expect(paneEnvService.revokeGeneration).toHaveBeenCalledWith(101, 'fetch_distribution_prereq_failed_rollback');
  });

  it('does NOT fail fast (and does not distribute) when distribution is not required and no working directory is configured', async () => {
    const server = makeServer({ name: 'srv-agent', type: 'agent', isolationIntent: false });
    const { useCase, taskRepo, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: false,
      taskWorkingDirectory: null,
    });

    await useCase.execute(10, 1);

    expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
    expect(taskRepo.updateStatusIfWindowMatches).not.toHaveBeenCalled();
  });
});

describe('ExecuteTaskUseCase fetch-distribution required-but-unwired fail-fast (Issue #87 review, 6th pass, Important finding 1)', () => {
  it('fails fast when distribution is required (isolated server) but FetchDistributionService is not wired', async () => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    const { useCase, taskRepo, tmux, paneEnvService, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: false,
      serviceWired: false,
    });

    await expect(useCase.execute(10, 1)).rejects.toThrow(/FetchDistributionService is not wired/);

    expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
    expect(taskRepo.updateStatusIfWindowMatches).toHaveBeenCalledWith(1, 'w1', 'failed', 101);
    expect(tmux.killWindow).toHaveBeenCalledWith(expect.anything(), 'azito:w1');
    expect(paneEnvService.revokeGeneration).toHaveBeenCalledWith(101, 'fetch_distribution_prereq_failed_rollback');
  });

  it('fails fast when distribution is required (project distribute_code opt-in) but FetchDistributionService is not wired', async () => {
    const server = makeServer({ name: 'srv-agent', type: 'agent', isolationIntent: false, sshHost: 'agent-host' });
    const { useCase, taskRepo, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: true,
      serviceWired: false,
    });

    await expect(useCase.execute(10, 1)).rejects.toThrow(/FetchDistributionService is not wired/);

    expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
    expect(taskRepo.updateStatusIfWindowMatches).toHaveBeenCalledWith(1, 'w1', 'failed', 101);
  });

  it('continues normally (no fail-fast, no distribute call) on a server where distribution is not required, even with FetchDistributionService unwired', async () => {
    const server = makeServer({ name: 'srv-agent', type: 'agent', isolationIntent: false });
    const { useCase, taskRepo, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: false,
      serviceWired: false,
    });

    await useCase.execute(10, 1);

    expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
    expect(taskRepo.updateStatusIfWindowMatches).not.toHaveBeenCalled();
  });

  it('continues normally on a local server even with FetchDistributionService unwired (local is never a distribution target)', async () => {
    const server = makeServer({ name: 'local-server', type: 'local', isolationIntent: false });
    const { useCase, taskRepo, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: true,
      serviceWired: false,
    });

    await useCase.execute(10, 1);

    expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
    expect(taskRepo.updateStatusIfWindowMatches).not.toHaveBeenCalled();
  });
});

// Issue #87 explicit-target follow-up: the "exactly one repository" fail-fast
// stopgap (DistributionHelper used to infer `project.repositories[0]` and
// refuse to guess with 2+) is gone — the target repository is now always
// resolved from `projectServer.distributionRepositoryId`, so a project with
// multiple repositories distributes normally as long as one is explicitly
// configured, and a project with exactly one repository is NOT inferred
// automatically (a missing `distributionRepositoryId` fails fast even then —
// see the "no distribution target repository is configured" test above).
describe('ExecuteTaskUseCase fetch-distribution explicit-target resolution (Issue #87 explicit-target follow-up, replaces the removed exactly-one-repository fail-fast)', () => {
  function projectWithTwoRepositories(): ProjectDetail {
    return makeProject({
      defaultUnitId: null,
      repositories: [
        { id: 5, name: null, url: fetchDistributionRepository.url, provider: 'github', owner: 'acme', repoName: 'widget', hasToken: true },
        { id: 6, name: null, url: 'https://github.com/acme/other.git', provider: 'github', owner: 'acme', repoName: 'other', hasToken: true },
      ],
    });
  }

  it('distributes from the explicitly configured repository when the project has more than one repository configured', async () => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    const { useCase, taskRepo, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: false,
      project: projectWithTwoRepositories(),
      distributionRepositoryId: 6,
      repository: { id: 6, url: 'https://github.com/acme/other.git', provider: 'github', owner: 'acme', repoName: 'other', token: 'tok456' },
    });

    await useCase.execute(10, 1);

    expect(fetchDistributionService.distribute).toHaveBeenCalledTimes(1);
    expect(taskRepo.updateStatusIfWindowMatches).not.toHaveBeenCalled();
  });

  it('distributes normally when distribution is required and the project has exactly one repository configured, as long as it is explicitly selected', async () => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    const { useCase, taskRepo, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: false,
      project: projectWithFetchDistributionRepository(),
    });

    await useCase.execute(10, 1);

    expect(fetchDistributionService.distribute).toHaveBeenCalledTimes(1);
    expect(taskRepo.updateStatusIfWindowMatches).not.toHaveBeenCalled();
  });

  it('fails fast (does not distribute) when the project has exactly one repository but no distribution target was explicitly selected (the old implicit-single-repository inference is gone)', async () => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    const { useCase, taskRepo, tmux, paneEnvService, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: false,
      project: projectWithFetchDistributionRepository(),
      distributionRepositoryId: null,
    });

    await expect(useCase.execute(10, 1)).rejects.toThrow(/no distribution target repository is configured/);

    expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
    expect(taskRepo.updateStatusIfWindowMatches).toHaveBeenCalledWith(1, 'w1', 'failed', 101);
    expect(tmux.killWindow).toHaveBeenCalledWith(expect.anything(), 'azito:w1');
    expect(paneEnvService.revokeGeneration).toHaveBeenCalledWith(101, 'fetch_distribution_prereq_failed_rollback');
  });

  it('does not fail fast on multiple repositories or a missing target when distribution is not required', async () => {
    const server = makeServer({ name: 'srv-agent', type: 'agent', isolationIntent: false });
    const { useCase, taskRepo, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: false,
      project: projectWithTwoRepositories(),
      distributionRepositoryId: null,
    });

    await useCase.execute(10, 1);

    expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
    expect(taskRepo.updateStatusIfWindowMatches).not.toHaveBeenCalled();
  });
});

// Issue #87 review follow-up, Important finding 1: `resumeStateMachine()`
// used to re-resolve the distribution target repository from the CURRENT
// project/project-server configuration every time it ran. Between when a
// task's execute() run actually distributed code onto its working directory
// and when it later gets resumed (a plan-approval wait, a startup recovery),
// `projectServer.distributionRepositoryId` can change — resuming against the
// new value would notarize/push repository A's already-distributed code
// against repository B. `Task.distributionRepositoryId` is persisted, once,
// at the moment distribution actually ran, and resume must use exactly that
// recorded value instead.
describe('ExecuteTaskUseCase persists task.distributionRepositoryId when distribution actually runs (Issue #87 review follow-up, Important finding 1)', () => {
  it('records the resolved repository id onto the task once fetch distribution succeeds', async () => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    const { useCase, taskRepo } = buildDistributionGateHarness({ server, distributeCode: false });

    await useCase.execute(10, 1);

    expect(taskRepo.update).toHaveBeenCalledWith(1, expect.objectContaining({ distributionRepositoryId: 5 }));
  });

  it('does not record a NON-NULL distributionRepositoryId when distribution never ran (distribution not required)', async () => {
    const server = makeServer({ name: 'srv-agent', type: 'agent', isolationIntent: false });
    const { useCase, taskRepo } = buildDistributionGateHarness({ server, distributeCode: false });

    await useCase.execute(10, 1);

    expect(taskRepo.update).not.toHaveBeenCalledWith(1, expect.objectContaining({ distributionRepositoryId: expect.anything() }));
  });

  // Issue #87 review follow-up, Important finding 4, superseded by Issue #87
  // review (forge/87-mirror follow-up), Important finding 3: a run that did
  // NOT distribute may clear a PRIOR run's recorded distributionRepositoryId
  // ONLY when there is positive evidence (a distribution_state row) that
  // the CURRENT server does not hold that repository's content — e.g. the
  // task moved off an isolated server back onto `local`. Modeled here via a
  // distributionStateRepo whose `find` returns null for this server/repo
  // pairing (no evidence this server ever received it).
  it('clears distributionRepositoryId when distribution does not run this call AND distribution_state proves this server does not hold the recorded repository', async () => {
    const server = makeServer({ name: 'srv-agent', type: 'agent', isolationIntent: false });
    const distributionStateRepo = { find: vi.fn(() => null) };
    const { useCase, taskRepo } = buildDistributionGateHarness({
      server,
      distributeCode: false,
      taskDistributionRepositoryId: 5,
      distributionStateRepo,
    });

    await useCase.execute(10, 1);

    expect(distributionStateRepo.find).toHaveBeenCalledWith('srv-agent', 5);
    expect(taskRepo.update).toHaveBeenCalledWith(1, expect.objectContaining({ distributionRepositoryId: null }));
  });

  // Issue #87 review (forge/87-mirror follow-up), Important finding 3: the
  // counterpart to the test above — a distribution_state row proving this
  // SAME server already holds the recorded repository's content (e.g.
  // distribute_code was toggled off after a prior successful distribution
  // on this exact server) must NOT be cleared. Clearing it would fall the
  // downstream repository resolution back to `project.repositories[0]`,
  // silently retargeting push/PR verification at a different repository
  // than what is actually checked out on disk.
  it('keeps distributionRepositoryId when distribution does not run this call BUT distribution_state proves this SAME server already holds the recorded repository', async () => {
    const server = makeServer({ name: 'srv-agent', type: 'agent', isolationIntent: false });
    const distributionStateRepo = {
      find: vi.fn((serverName: string, repositoryId: number) =>
        serverName === 'srv-agent' && repositoryId === 5
          ? { lastDistributedSha: 'a'.repeat(40), bundleType: 'full', distributedAt: '2026-01-01T00:00:00Z' }
          : null),
    };
    const { useCase, taskRepo } = buildDistributionGateHarness({
      server,
      distributeCode: false,
      taskDistributionRepositoryId: 5,
      distributionStateRepo,
    });

    await useCase.execute(10, 1);

    expect(distributionStateRepo.find).toHaveBeenCalledWith('srv-agent', 5);
    expect(taskRepo.update).not.toHaveBeenCalledWith(1, expect.objectContaining({ distributionRepositoryId: null }));
  });

  // Issue #87 review (forge/87-mirror follow-up), Important finding 3: when
  // distributionStateRepo is not wired at all (the pre-existing default for
  // every other test in this file), there is no way to corroborate whether
  // the current server holds the recorded repository's content — the record
  // must be left untouched rather than cleared ("insufficient information
  // fails toward keeping the record", not toward clearing it).
  it('keeps distributionRepositoryId when distribution does not run this call and distributionStateRepo is not wired', async () => {
    const server = makeServer({ name: 'srv-agent', type: 'agent', isolationIntent: false });
    const { useCase, taskRepo } = buildDistributionGateHarness({
      server,
      distributeCode: false,
      taskDistributionRepositoryId: 5,
    });

    await useCase.execute(10, 1);

    expect(taskRepo.update).not.toHaveBeenCalledWith(1, expect.objectContaining({ distributionRepositoryId: null }));
  });

  // Issue #87 review (forge/87-mirror follow-up), Important finding 2
  // (third round): the record-write callback is threaded through
  // `performDistribution()` -> `fetchDistributionService.distribute()` as
  // `onBeforeWorkingDirChange`, NOT invoked by `performDistribution()`
  // itself before `distribute()` is even called (the previous round's fix,
  // superseded here — see DistributionHelper.ts's `onBeforeDistribute` doc
  // comment). This asserts the wiring: `distribute()` is called WITH the
  // callback.
  it('threads the record-write callback into distribute() as onBeforeWorkingDirChange, rather than firing it before distribute() is even called', async () => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    const { useCase, taskRepo, fetchDistributionService } = buildDistributionGateHarness({ server, distributeCode: false });

    await useCase.execute(10, 1);

    expect(fetchDistributionService.distribute).toHaveBeenCalledWith(
      expect.objectContaining({ onBeforeWorkingDirChange: expect.any(Function) }),
    );
    expect(taskRepo.update).toHaveBeenCalledWith(1, expect.objectContaining({ distributionRepositoryId: 5 }));
  });

  // Issue #87 review (forge/87-mirror follow-up), Important finding 2
  // (third round), superseding the prior "still records the attempted
  // distributionRepositoryId even when fetch distribution fails" test:
  // `distribute()` can fail BEFORE ever reaching the working-directory
  // mutation step (resolving sshHost's home directory, preparing the hub's
  // repo cache, transferring the bundle onto the remote mirror). A failure
  // at any of those stages means `onBeforeWorkingDirChange` never fires, so
  // the record must NOT be written — the working directory was never
  // touched this run. `buildDistributionGateHarness`'s fake `distribute()`
  // deliberately skips calling `onBeforeWorkingDirChange` for a
  // `distributeResult.status === 'failed'`, modeling exactly that.
  it('does NOT record a distributionRepositoryId when fetch distribution fails before ever calling onBeforeWorkingDirChange (i.e. before touching the working directory)', async () => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    const { useCase, taskRepo, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: false,
      distributeResult: { status: 'failed', error: 'network boom' },
    });

    await expect(useCase.execute(10, 1)).rejects.toThrow(/network boom/);

    expect(fetchDistributionService.distribute).toHaveBeenCalledTimes(1);
    expect(taskRepo.update).not.toHaveBeenCalledWith(1, expect.objectContaining({ distributionRepositoryId: expect.anything() }));
  });

  // Issue #87 review follow-up (second round, Important finding 1): a
  // prerequisite check failure (none of which ever touch the remote) must
  // NOT overwrite a PRIOR run's recorded target — the working directory
  // still holds whatever that prior run actually distributed, so the
  // record naming it must survive untouched. `onBeforeDistribute` is never
  // invoked when `performDistribution` returns before its point of no
  // return, so no write happens at all — the earlier `taskRepo.update`
  // call (from the record's actual prior run) stands unchallenged.
  it('does NOT overwrite a previously recorded distributionRepositoryId when a prerequisite check fails (no distribution target configured)', async () => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    const { useCase, taskRepo, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: false,
      distributionRepositoryId: null,
      taskDistributionRepositoryId: 7,
    });

    await expect(useCase.execute(10, 1)).rejects.toThrow(/no distribution target repository is configured/);

    expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
    expect(taskRepo.update).not.toHaveBeenCalledWith(1, expect.objectContaining({ distributionRepositoryId: expect.anything() }));
  });

  it('does NOT overwrite a previously recorded distributionRepositoryId when a prerequisite check fails (no token configured)', async () => {
    const server = makeServer({ name: 'srv-agent', type: 'agent', isolationIntent: false, sshHost: 'agent-host' });
    const { useCase, taskRepo, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: true,
      repository: { ...fetchDistributionRepository, token: null },
      taskDistributionRepositoryId: 7,
    });

    await expect(useCase.execute(10, 1)).rejects.toThrow(/no token configured/);

    expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
    expect(taskRepo.update).not.toHaveBeenCalledWith(1, expect.objectContaining({ distributionRepositoryId: expect.anything() }));
  });

  it('does NOT overwrite a previously recorded distributionRepositoryId when a prerequisite check fails (identity unresolvable)', async () => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    const { useCase, taskRepo, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: false,
      repository: { ...fetchDistributionRepository, url: 'http://github.com/acme/widget.git' },
      taskDistributionRepositoryId: 7,
    });

    await expect(useCase.execute(10, 1)).rejects.toThrow(/could not be normalized/);

    expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
    expect(taskRepo.update).not.toHaveBeenCalledWith(1, expect.objectContaining({ distributionRepositoryId: expect.anything() }));
  });

  it('does NOT overwrite a previously recorded distributionRepositoryId when a prerequisite check fails (no working directory configured)', async () => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    const { useCase, taskRepo, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: false,
      taskWorkingDirectory: null,
      taskDistributionRepositoryId: 7,
    });

    await expect(useCase.execute(10, 1)).rejects.toThrow(/no working directory is configured/);

    expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
    expect(taskRepo.update).not.toHaveBeenCalledWith(1, expect.objectContaining({ distributionRepositoryId: expect.anything() }));
  });

  it('does NOT overwrite a previously recorded distributionRepositoryId when a prerequisite check fails (FetchDistributionService not wired)', async () => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    const { useCase, taskRepo, fetchDistributionService } = buildDistributionGateHarness({
      server,
      distributeCode: false,
      serviceWired: false,
      taskDistributionRepositoryId: 7,
    });

    await expect(useCase.execute(10, 1)).rejects.toThrow(/FetchDistributionService is not wired/);

    expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
    expect(taskRepo.update).not.toHaveBeenCalledWith(1, expect.objectContaining({ distributionRepositoryId: expect.anything() }));
  });
});

describe('ExecuteTaskUseCase.resumeStateMachine uses the task-recorded distribution repository, never the current config (Issue #87 review follow-up, Important finding 1)', () => {
  function repoWithId(id: number) {
    return { id, name: null, url: `https://github.com/acme/repo-${id}.git`, provider: 'github' as const, owner: 'acme', repoName: `repo-${id}`, hasToken: true };
  }

  it('fails the task closed (never falls back to the current project-server config) when the recorded distributionRepositoryId no longer resolves on the project', async () => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    // Task was previously distributed from repo id 5, which has since been
    // deleted from the project (repositories list no longer contains it) —
    // the CURRENT project-server config points at repo 6 instead, but that
    // must never be silently substituted in.
    const task = makeTask({
      id: 1, serverName: server.name, unitId: 10, workingDirectory: '/srv/repo',
      distributionRepositoryId: 5,
    });
    const { useCase, taskRepo } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null, repositories: [repoWithId(6)] }),
      units: [makeUnit({ id: 10, workerType: 'claude', workerModel: 'opus' })],
      projectServer: { workingDirectory: null, branch: null, tmuxSession: 'azito', distributeCode: false, distributionRepositoryId: 6 },
      server,
    });

    await useCase.resumeStateMachine(10, 1);

    expect(taskRepo.updateStatus).toHaveBeenCalledWith(1, 'failed');
  });

  it('does not fail closed when the recorded distributionRepositoryId still resolves, even though the current config now points elsewhere', async () => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    const task = makeTask({
      id: 1, serverName: server.name, unitId: 10, workingDirectory: '/srv/repo',
      distributionRepositoryId: 5,
    });
    const { useCase, taskRepo } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null, repositories: [repoWithId(5), repoWithId(6)] }),
      units: [makeUnit({ id: 10, workerType: 'claude', workerModel: 'opus' })],
      // Current config has since moved to repo 6 — must be ignored in favor
      // of the task's own recorded value (repo 5).
      projectServer: { workingDirectory: null, branch: null, tmuxSession: 'azito', distributeCode: false, distributionRepositoryId: 6 },
      server,
    });

    await useCase.resumeStateMachine(10, 1);

    expect(taskRepo.updateStatus).not.toHaveBeenCalledWith(1, 'failed');
  });

  it('falls back to the current config (repositories[0]) when no distributionRepositoryId was ever recorded and distribution is not required for this server', async () => {
    const server = makeServer({ name: 'srv-agent', type: 'agent', isolationIntent: false });
    const task = makeTask({ id: 1, serverName: server.name, unitId: 10, workingDirectory: '/srv/repo' });
    const { useCase, taskRepo } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null, repositories: [repoWithId(5)] }),
      units: [makeUnit({ id: 10, workerType: 'claude', workerModel: 'opus' })],
      projectServer: { workingDirectory: null, branch: null, tmuxSession: 'azito', distributeCode: false, distributionRepositoryId: null },
      server,
    });

    await useCase.resumeStateMachine(10, 1);

    expect(taskRepo.updateStatus).not.toHaveBeenCalledWith(1, 'failed');
  });

  it('fails closed when no distributionRepositoryId was ever recorded but distribution IS required for this server (mirrors resolveExecutionRepositoryEntry\'s existing fail-closed rule)', async () => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    const task = makeTask({ id: 1, serverName: server.name, unitId: 10, workingDirectory: '/srv/repo' });
    const { useCase, taskRepo } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null, repositories: [repoWithId(5)] }),
      units: [makeUnit({ id: 10, workerType: 'claude', workerModel: 'opus' })],
      projectServer: { workingDirectory: null, branch: null, tmuxSession: 'azito', distributeCode: false, distributionRepositoryId: null },
      server,
    });

    // Not asserted as an immediate task-failed status write (unlike the
    // recorded-but-unresolvable case above, this path hands `null` down to
    // PhaseLoopRunner, which applies its own existing fail-closed handling
    // for a null distributionRepoEntry) — this test only pins that
    // resumeStateMachine itself does not crash and does not mark the task
    // failed synchronously for a merely-never-distributed task.
    await expect(useCase.resumeStateMachine(10, 1)).resolves.toBeUndefined();
  });

  // Issue #87 review (forge/87-mirror follow-up), Important finding 2
  // (third round): reproduces the "disable distribution, then resume, then
  // delete the recorded repository before pushing" flow. `distributeCode`
  // has been turned OFF (and the server isn't isolation_intent) by the time
  // resume runs — a fresh `isDistributionRequired(server, projectServer)`
  // read would say `false` — but this task's own `distributionRepositoryId`
  // is still recorded (a PAST run of this same task actually distributed
  // code from it), which is proof this run's working directory content came
  // from that repository and must still be verified against it. The
  // `distributionRequired` flag passed to `stateMachineLoop` must therefore
  // stay `true`: PhaseLoopRunner locks this flag for the entire run (see
  // PhaseLoopRunner.test.ts's "stays fail-closed on the caller-locked
  // distributionRequired=true" test), so a WRONG `false` computed here would
  // let the pushing-phase probe silently accept a bare SHA match if the
  // recorded repository is deleted at any point before pushing — reviving
  // exactly the bypass this column was added to close.
  it('keeps distributionRequired=true for the pushing-phase probe when distribution has been disabled in the CURRENT config but this task recorded a distribution repository from a past run', async () => {
    const server = makeServer({ name: 'srv-agent', type: 'agent', isolationIntent: false });
    const task = makeTask({
      id: 1, serverName: server.name, unitId: 10, workingDirectory: '/srv/repo',
      distributionRepositoryId: 5,
    });
    const { useCase, taskRepo } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null, repositories: [repoWithId(5)] }),
      units: [makeUnit({ id: 10, workerType: 'claude', workerModel: 'opus' })],
      // distribute_code has since been turned OFF, and the server was never
      // isolation_intent — a fresh read of THIS row alone would say
      // distribution is no longer required.
      projectServer: { workingDirectory: null, branch: null, tmuxSession: 'azito', distributeCode: false, distributionRepositoryId: null },
      server,
    });
    const stateMachineLoop = vi.fn(async () => {});
    (useCase as any).phaseLoopRunner.stateMachineLoop = stateMachineLoop;

    await useCase.resumeStateMachine(10, 1);

    expect(stateMachineLoop).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(),
      expect.objectContaining({ id: 5 }),
      true,
    );
    expect(taskRepo.updateStatus).not.toHaveBeenCalledWith(1, 'failed');
  });
});

// Issue #87 review follow-up, Important finding 2: followUp()'s
// state-machine continuation (resuming the phase loop after a phase_complete
// classification) must apply the SAME "recorded distribution repository is
// authoritative, fail closed if it no longer resolves" rule
// resumeStateMachine() does, via the shared
// resolveRecordedDistributionRepositoryEntry() helper — not re-resolve from
// followUpProject/followUpProjectServer's CURRENT configuration.
//
// The plumbing between sendPrompt and the phase-loop continuation
// (pane/signal streams, marker waiting) is stubbed directly on the real
// WorkerWaiter instance the use case holds (same trick PhaseLoopRunner.test.ts
// uses) — this test's only concern is which distributionRepoEntry
// followUp()'s continuation resolves and hands to (a stubbed)
// PhaseLoopRunner.stateMachineLoop, and whether it fails the task closed
// instead of calling it at all.
describe('ExecuteTaskUseCase.followUp state-machine continuation uses the task-recorded distribution repository, never the current config (Issue #87 review follow-up, Important finding 2)', () => {
  function repoWithId(id: number) {
    return { id, name: null, url: `https://github.com/acme/repo-${id}.git`, provider: 'github' as const, owner: 'acme', repoName: `repo-${id}`, hasToken: true };
  }

  function stubWorkerPlumbing(useCase: ReturnType<typeof buildUseCase>['useCase']) {
    const workerWaiter = (useCase as any).workerWaiter;
    workerWaiter.startPaneStream = vi.fn(() => ({ stop: vi.fn(), getBuffer: () => '', getFilePath: () => '/tmp/pane' }));
    workerWaiter.startSignalStream = vi.fn(() => ({ stop: vi.fn(), getFilePath: () => '/tmp/sig' }));
    workerWaiter.waitForWorker = vi.fn(async () => ({ output: 'done', classification: { status: 'phase_complete' as const } }));
    workerWaiter.readPhaseOutputFile = vi.fn(async () => 'plan output');
    (useCase as any).phaseLoopRunner.stateMachineLoop = vi.fn(async () => {});
    return (useCase as any).phaseLoopRunner.stateMachineLoop as ReturnType<typeof vi.fn>;
  }

  // followUp() itself returns once the prompt is sent — the actual
  // continuation (runFollowUp) runs fire-and-forget in the background, same
  // as the existing http-signal followUp test above. Flushing microtasks a
  // number of times lets it run to completion without real timers.
  async function flushMicrotasks(times = 30) {
    for (let i = 0; i < times; i++) await Promise.resolve();
  }

  function makeUnitTypeWithImplementingPhase() {
    return {
      name: 'devops', label: 'DevOps', description: '',
      phases: [{
        name: 'implementing', label: 'Implementing', tags: [], questions: false,
        testFailed: false, planApproval: false, selfReviewRetry: false, pushVerify: false,
      }],
    };
  }

  it('resumes the phase loop with the RECORDED repository (A), even though the current project-server config now points at repository B', async () => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    const task = makeTask({
      id: 1, serverName: server.name, unitId: 10, currentPhase: 'implementing',
      tmuxWindow: 'task-1', workingDirectory: '/srv/repo',
      distributionRepositoryId: 1,
    });
    const { useCase, taskRepo, tmux, unitTypeLoader } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null, repositories: [repoWithId(1), repoWithId(2)] }),
      units: [makeUnit({ id: 10, workerType: 'claude', workerModel: 'opus', workerExecutionMode: 'tmux-pipe' })],
      // Current config has since moved to repo 2 — must be ignored in favor
      // of the task's own recorded value (repo 1).
      projectServer: { workingDirectory: null, branch: null, tmuxSession: 'azito', distributeCode: false, distributionRepositoryId: 2 },
      server,
    });
    (unitTypeLoader.get as ReturnType<typeof vi.fn>).mockReturnValue(makeUnitTypeWithImplementingPhase());
    (tmux.listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'azito', windows: [{ name: 'task-1', index: 1 }] }]);
    const stateMachineLoop = stubWorkerPlumbing(useCase);

    await useCase.followUp(10, 1, 'please continue');
    await flushMicrotasks();

    expect(stateMachineLoop).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(),
      expect.objectContaining({ id: 1 }),
      // isolationIntent alone (server-level) requires distribution,
      // regardless of the current project-server's distributeCode — see
      // isDistributionRequired's doc comment (DistributionHelper.ts).
      true,
    );
    expect(taskRepo.updateStatus).not.toHaveBeenCalledWith(1, 'failed');
  });

  it('fails the task closed (never calls stateMachineLoop) when the recorded distributionRepositoryId no longer resolves on the project', async () => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    const task = makeTask({
      id: 1, serverName: server.name, unitId: 10, currentPhase: 'implementing',
      tmuxWindow: 'task-1', workingDirectory: '/srv/repo',
      // Recorded repository (id 5) has since been deleted from the project.
      distributionRepositoryId: 5,
    });
    const { useCase, taskRepo, tmux, unitTypeLoader } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null, repositories: [repoWithId(2)] }),
      units: [makeUnit({ id: 10, workerType: 'claude', workerModel: 'opus', workerExecutionMode: 'tmux-pipe' })],
      projectServer: { workingDirectory: null, branch: null, tmuxSession: 'azito', distributeCode: false, distributionRepositoryId: 2 },
      server,
    });
    (unitTypeLoader.get as ReturnType<typeof vi.fn>).mockReturnValue(makeUnitTypeWithImplementingPhase());
    (tmux.listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'azito', windows: [{ name: 'task-1', index: 1 }] }]);
    const stateMachineLoop = stubWorkerPlumbing(useCase);

    await useCase.followUp(10, 1, 'please continue');
    await flushMicrotasks();

    expect(stateMachineLoop).not.toHaveBeenCalled();
    expect(taskRepo.updateStatus).toHaveBeenCalledWith(1, 'failed');
  });

  // Issue #87 review (forge/87-mirror follow-up), Important finding 2
  // (third round) — same "disable distribution, then resume/follow-up, then
  // delete the recorded repository before pushing" flow as
  // resumeStateMachine's own test of the same name, but for follow-up's
  // state-machine continuation.
  it('keeps distributionRequired=true for the pushing-phase probe when distribution has been disabled in the CURRENT config but this task recorded a distribution repository from a past run', async () => {
    const server = makeServer({ name: 'srv-agent', type: 'agent', isolationIntent: false });
    const task = makeTask({
      id: 1, serverName: server.name, unitId: 10, currentPhase: 'implementing',
      tmuxWindow: 'task-1', workingDirectory: '/srv/repo',
      distributionRepositoryId: 5,
    });
    const { useCase, taskRepo, tmux, unitTypeLoader } = buildUseCase({
      task,
      project: makeProject({ defaultUnitId: null, repositories: [repoWithId(5)] }),
      units: [makeUnit({ id: 10, workerType: 'claude', workerModel: 'opus', workerExecutionMode: 'tmux-pipe' })],
      // distribute_code has since been turned OFF, and the server was never
      // isolation_intent — a fresh read of THIS row alone would say
      // distribution is no longer required.
      projectServer: { workingDirectory: null, branch: null, tmuxSession: 'azito', distributeCode: false, distributionRepositoryId: null },
      server,
    });
    (unitTypeLoader.get as ReturnType<typeof vi.fn>).mockReturnValue(makeUnitTypeWithImplementingPhase());
    (tmux.listSessions as ReturnType<typeof vi.fn>).mockResolvedValue([{ name: 'azito', windows: [{ name: 'task-1', index: 1 }] }]);
    const stateMachineLoop = stubWorkerPlumbing(useCase);

    await useCase.followUp(10, 1, 'please continue');
    await flushMicrotasks();

    expect(stateMachineLoop).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything(),
      expect.objectContaining({ id: 5 }),
      true,
    );
    expect(taskRepo.updateStatus).not.toHaveBeenCalledWith(1, 'failed');
  });
});

describe('ExecuteTaskUseCase base-branch canonicalization before distribution (Issue #87 third-party review, 11th round, Important finding 1)', () => {
  it.each([
    ['origin/main'],
    ['refs/heads/main'],
  ])('normalizes baseBranch %s to "main" for distribute(), and resolves the worktree base to "origin/main"', async (taskBaseBranch) => {
    const server = makeServer({ name: 'srv-isolated', type: 'agent', isolationIntent: true });
    const { useCase, fetchDistributionService, worktreeServiceFactory } = buildDistributionGateHarness({
      server,
      distributeCode: false,
      taskBaseBranch,
    });
    const worktreeCreate = vi.fn(async () => ({ path: '/srv/repo/.worktrees/task-1', branch: 'task/1-slug' }));
    worktreeServiceFactory.create.mockReturnValue({ create: worktreeCreate });

    await useCase.execute(10, 1);

    // distribute() must receive the canonicalized, plain branch name — an
    // `origin/`- or `refs/heads/`-qualified value used to reach `distribute()`
    // unnormalized and fail the fetch against the nonexistent ref
    // `refs/heads/origin/main`.
    expect(fetchDistributionService.distribute).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'main' }),
    );

    // Worktree creation resolves from `origin/<canonicalized baseBranch>`
    // (distStatus is 'distributed' by default in this harness), never
    // `origin/origin/main` or `origin/refs/heads/main`.
    expect(worktreeCreate).toHaveBeenCalledWith(
      '/srv/repo', 1, expect.any(String), 'origin/main', undefined,
    );
  });
});

// Issue #87 13th-round review, Important finding: isPushCompleted() (the
// startup-recovery fallback for a task stuck mid-pushing, see
// RecoverStuckTasksUseCase) must resolve the SAME repository fetch
// distribution actually pulled onto the server, not always
// `project.repositories[0]` — otherwise a project with a second repository
// choosing repository B as its distribution target would have B's PR
// existence checked/created against A.
describe('ExecuteTaskUseCase.isPushCompleted repository selection agrees with distribution target (Issue #87 13th-round review)', () => {
  const repoA = { id: 1, name: null, url: 'https://github.com/acme/repo-a.git', provider: 'github' as const, owner: 'acme', repoName: 'repo-a', hasToken: true };
  const repoB = { id: 2, name: null, url: 'https://github.com/acme/repo-b.git', provider: 'github' as const, owner: 'acme', repoName: 'repo-b', hasToken: true };
  const repoAWithToken = { ...repoA, token: 'tok-a' };
  const repoBWithToken = { ...repoB, token: 'tok-b' };

  it('resolves repository B (the configured distribution target), not A (repositories[0]), for PR creation', async () => {
    const task = makeTask({
      id: 1, unitId: 10, serverName: 'agent-1',
      workingDirectory: '/work', worktreeBranch: 'task/1-slug', skipPr: false,
    });
    const server = makeServer({ name: 'agent-1', type: 'agent', isolationIntent: false });
    const project = makeProject({ defaultUnitId: null, repositories: [repoA, repoB] });
    const unit = makeUnit({ id: 10 });
    const harness = buildUseCase({
      task, project, units: [unit], server,
      projectServer: { workingDirectory: '/work', branch: null, tmuxSession: 'azito', distributeCode: true, distributionRepositoryId: repoB.id },
    });
    harness.projectRepo.findRepositoryById = vi.fn((id: number) => (id === repoB.id ? repoBWithToken : repoAWithToken));

    await harness.useCase.isPushCompleted(1);

    expect(harness.gitProvider.findPullRequestByBranch).toHaveBeenCalledWith(repoBWithToken, 'task/1-slug');
    expect(harness.gitProvider.findPullRequestByBranch).not.toHaveBeenCalledWith(repoAWithToken, expect.anything());
  });

  it('falls back to repository A (repositories[0]) when distribution is not active for this project/server', async () => {
    const task = makeTask({
      id: 1, unitId: 10, serverName: 'agent-1',
      workingDirectory: '/work', worktreeBranch: 'task/1-slug', skipPr: false,
    });
    const server = makeServer({ name: 'agent-1', type: 'agent', isolationIntent: false });
    const project = makeProject({ defaultUnitId: null, repositories: [repoA, repoB] });
    const unit = makeUnit({ id: 10 });
    const harness = buildUseCase({
      task, project, units: [unit], server,
      // distributionRepositoryId set, but distribute_code is off and the
      // server isn't isolated — distribution is not active for this
      // pairing, so this must keep resolving repositories[0] the way every
      // project not using hub-代行 distribution always has.
      projectServer: { workingDirectory: '/work', branch: null, tmuxSession: 'azito', distributeCode: false, distributionRepositoryId: repoB.id },
    });
    harness.projectRepo.findRepositoryById = vi.fn((id: number) => (id === repoB.id ? repoBWithToken : repoAWithToken));

    await harness.useCase.isPushCompleted(1);

    expect(harness.gitProvider.findPullRequestByBranch).toHaveBeenCalledWith(repoAWithToken, 'task/1-slug');
  });
});

// 指摘1 (Issue #87 review): when distribution is required but
// `resolveExecutionRepositoryEntry` cannot identify the distributed
// repository (distributionRepositoryId unset, or the repository row was
// deleted), `isPushCompleted()` must treat the run as not-yet-completed —
// never fall into `PushVerifier`'s "no repo info, skip PR check" fallback,
// which would accept a bare SHA match as "push completed" even though the
// required repository/PR could not be identified.
describe('ExecuteTaskUseCase.isPushCompleted fails closed when a required distribution repository is unresolved (Issue #87 review)', () => {
  const repoA = { id: 1, name: null, url: 'https://github.com/acme/repo-a.git', provider: 'github' as const, owner: 'acme', repoName: 'repo-a', hasToken: true };

  it('returns false and calls neither PR creation nor push verification when distribution is required but distributionRepositoryId is unset', async () => {
    const task = makeTask({
      id: 1, unitId: 10, serverName: 'agent-1',
      workingDirectory: '/work', worktreeBranch: 'task/1-slug', skipPr: false,
    });
    const server = makeServer({ name: 'agent-1', type: 'agent', isolationIntent: true });
    const project = makeProject({ defaultUnitId: null, repositories: [repoA] });
    const unit = makeUnit({ id: 10 });
    const harness = buildUseCase({
      task, project, units: [unit], server,
      projectServer: { workingDirectory: '/work', branch: null, tmuxSession: 'azito', distributeCode: false, distributionRepositoryId: null },
    });

    const result = await harness.useCase.isPushCompleted(1);

    expect(result).toBe(false);
    expect(harness.gitProvider.findPullRequestByBranch).not.toHaveBeenCalled();
    expect(harness.tmux.execCommand).not.toHaveBeenCalled();
  });

  it('keeps SHA-only verification when distribution is not required, even with no repositories registered', async () => {
    const task = makeTask({
      id: 1, unitId: 10, serverName: 'agent-1',
      workingDirectory: '/work', worktreeBranch: 'task/1-slug', skipPr: true,
    });
    const server = makeServer({ name: 'agent-1', type: 'agent', isolationIntent: false });
    const project = makeProject({ defaultUnitId: null, repositories: [] });
    const unit = makeUnit({ id: 10 });
    const harness = buildUseCase({
      task, project, units: [unit], server,
      projectServer: { workingDirectory: '/work', branch: null, tmuxSession: 'azito', distributeCode: false, distributionRepositoryId: null },
    });
    const fakeSha = 'a'.repeat(40);
    harness.tmux.execCommand = vi.fn(async (_server: unknown, cmd: string) => {
      if (cmd.includes('rev-parse HEAD')) return { stdout: `${fakeSha}\n`, stderr: '', code: 0 };
      if (cmd.includes('ls-remote')) return { stdout: `${fakeSha}\trefs/heads/task/1-slug\n`, stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    const result = await harness.useCase.isPushCompleted(1);

    expect(result).toBe(true);
  });

  // Issue #87 review (forge/87-mirror follow-up), Important finding 2
  // (third round): the "disable distribution, then resume, then delete the
  // recorded repository before pushing" flow, for isPushCompleted()
  // specifically. `distribute_code` is OFF and the server isn't
  // isolation_intent (a fresh `isDistributionRequired` read would say
  // `false`), but this task recorded a distribution repository from a past
  // run and that repository has since been removed (simulated here via
  // `findRepositoryById` returning nothing for the recorded id, the same
  // observable effect a deleted repository row has) — must fail closed
  // (return false, never call PR creation/verification with a null repo,
  // which would let PushVerifier fall back to its bare-SHA-match path).
  it('fails closed (never falls back to SHA-only verification) when the recorded distribution repository can no longer be resolved and distribution is disabled in the CURRENT config', async () => {
    const task = makeTask({
      id: 1, unitId: 10, serverName: 'agent-1',
      workingDirectory: '/work', worktreeBranch: 'task/1-slug', skipPr: false,
      distributionRepositoryId: 5,
    });
    const server = makeServer({ name: 'agent-1', type: 'agent', isolationIntent: false });
    const project = makeProject({ defaultUnitId: null, repositories: [{ id: 5, name: null, url: 'https://github.com/acme/repo-e.git', provider: 'github' as const, owner: 'acme', repoName: 'repo-e', hasToken: true }] });
    const unit = makeUnit({ id: 10 });
    const harness = buildUseCase({
      task, project, units: [unit], server,
      projectServer: { workingDirectory: '/work', branch: null, tmuxSession: 'azito', distributeCode: false, distributionRepositoryId: null },
    });
    // Simulates the recorded repository row having been removed between the
    // project listing and this lookup — the entry still appears in
    // `project.repositories` above, but the full row (with token) is gone.
    harness.projectRepo.findRepositoryById = vi.fn(() => null);

    const result = await harness.useCase.isPushCompleted(1);

    expect(result).toBe(false);
    expect(harness.gitProvider.findPullRequestByBranch).not.toHaveBeenCalled();
    expect(harness.tmux.execCommand).not.toHaveBeenCalled();
  });
});

// Issue #87 review follow-up, Important finding 3: isPushCompleted() must
// use the task's RECORDED distribution repository (same rule
// resumeStateMachine()/followUp() apply via
// resolveRecordedDistributionRepositoryEntry), not re-resolve from the
// project-server's CURRENT distributionRepositoryId — a working tree
// distributed from repository A must never have its push/PR verified
// against repository B just because the config changed while the task was
// pushing.
describe('ExecuteTaskUseCase.isPushCompleted uses the task-recorded distribution repository, never the current config (Issue #87 review follow-up, Important finding 3)', () => {
  const repoA = { id: 1, name: null, url: 'https://github.com/acme/repo-a.git', provider: 'github' as const, owner: 'acme', repoName: 'repo-a', hasToken: true };
  const repoB = { id: 2, name: null, url: 'https://github.com/acme/repo-b.git', provider: 'github' as const, owner: 'acme', repoName: 'repo-b', hasToken: true };
  const repoAWithToken = { ...repoA, token: 'tok-a' };
  const repoBWithToken = { ...repoB, token: 'tok-b' };

  it('verifies/creates the PR against the RECORDED repository (A), even though the current project-server config now points at repository B', async () => {
    const task = makeTask({
      id: 1, unitId: 10, serverName: 'agent-1',
      workingDirectory: '/work', worktreeBranch: 'task/1-slug', skipPr: false,
      distributionRepositoryId: repoA.id,
    });
    const server = makeServer({ name: 'agent-1', type: 'agent', isolationIntent: true });
    const project = makeProject({ defaultUnitId: null, repositories: [repoA, repoB] });
    const unit = makeUnit({ id: 10 });
    const harness = buildUseCase({
      task, project, units: [unit], server,
      // Current config has since moved to repo B — must be ignored in favor
      // of the task's own recorded value (repo A).
      projectServer: { workingDirectory: '/work', branch: null, tmuxSession: 'azito', distributeCode: false, distributionRepositoryId: repoB.id },
    });
    harness.projectRepo.findRepositoryById = vi.fn((id: number) => (id === repoA.id ? repoAWithToken : repoBWithToken));

    await harness.useCase.isPushCompleted(1);

    expect(harness.gitProvider.findPullRequestByBranch).toHaveBeenCalledWith(repoAWithToken, 'task/1-slug');
    expect(harness.gitProvider.findPullRequestByBranch).not.toHaveBeenCalledWith(repoBWithToken, expect.anything());
  });

  it('fails closed (returns false, calls neither PR creation nor push verification) when the recorded distributionRepositoryId no longer resolves on the project', async () => {
    const task = makeTask({
      id: 1, unitId: 10, serverName: 'agent-1',
      workingDirectory: '/work', worktreeBranch: 'task/1-slug', skipPr: false,
      // Recorded repository (id 99) was deleted from the project — only
      // repo B remains, but that must never be silently substituted in.
      distributionRepositoryId: 99,
    });
    const server = makeServer({ name: 'agent-1', type: 'agent', isolationIntent: true });
    const project = makeProject({ defaultUnitId: null, repositories: [repoB] });
    const unit = makeUnit({ id: 10 });
    const harness = buildUseCase({
      task, project, units: [unit], server,
      projectServer: { workingDirectory: '/work', branch: null, tmuxSession: 'azito', distributeCode: false, distributionRepositoryId: repoB.id },
    });

    const result = await harness.useCase.isPushCompleted(1);

    expect(result).toBe(false);
    expect(harness.gitProvider.findPullRequestByBranch).not.toHaveBeenCalled();
    expect(harness.tmux.execCommand).not.toHaveBeenCalled();
  });

  it('falls back to the current config (repositories[0]) when the task has no recorded distributionRepositoryId (predates the column / never distributed)', async () => {
    const task = makeTask({
      id: 1, unitId: 10, serverName: 'agent-1',
      workingDirectory: '/work', worktreeBranch: 'task/1-slug', skipPr: false,
      distributionRepositoryId: null,
    });
    const server = makeServer({ name: 'agent-1', type: 'agent', isolationIntent: false });
    const project = makeProject({ defaultUnitId: null, repositories: [repoA, repoB] });
    const unit = makeUnit({ id: 10 });
    const harness = buildUseCase({
      task, project, units: [unit], server,
      projectServer: { workingDirectory: '/work', branch: null, tmuxSession: 'azito', distributeCode: false, distributionRepositoryId: repoB.id },
    });
    harness.projectRepo.findRepositoryById = vi.fn((id: number) => (id === repoA.id ? repoAWithToken : repoBWithToken));

    await harness.useCase.isPushCompleted(1);

    expect(harness.gitProvider.findPullRequestByBranch).toHaveBeenCalledWith(repoAWithToken, 'task/1-slug');
  });
});
