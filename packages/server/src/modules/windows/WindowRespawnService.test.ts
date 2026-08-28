import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { WindowRespawnService, buildRespawnManifestInput } from './WindowRespawnService';
import { KeyedMutex } from '../../shared/keyedMutex';
import { resolveExecutionManifest, hashExecutionManifest } from '../tasks/execution/ExecutionManifest';
import type { Window, IWindowRepository } from './Window';
import type { ServerConfig } from '../servers/Server';
import type { ITaskRepository, Task } from '../tasks/Task';
import type { IUnitRepository, Unit } from '../units/Unit';
import type { IProjectServerRepository } from '../projects/ProjectServer';
import type { IProjectRepository } from '../projects/Project';
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
    sleeping: false,
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
    isolationIntent: false,
    isolationVerifiedAt: null,
    isolationReport: null, isolationCleanupReport: null,
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
    sleepAfterPush: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// projectServerRepo/transportFactory are now required constructor
// dependencies (Issue #27 review Minor finding: an optional dependency let
// containment verification be silently skipped by a wiring omission, not
// just by a genuine "no allowedRoot configured" case). Tests that don't
// care about containment get a repo that reports no workingDirectory
// (allowedRoot === null), which is the real "no boundary to enforce" skip
// path — not an unwired dependency.
function defaultProjectServerRepo(): Pick<IProjectServerRepository, 'find' | 'findByProject'> {
  return { find: vi.fn(() => null), findByProject: vi.fn(() => []) };
}

function defaultTransportFactory(): Pick<TransportFactory, 'getTransport'> {
  return { getTransport: vi.fn(() => ({})) } as unknown as Pick<TransportFactory, 'getTransport'>;
}

// resolveExecutionManifest() (Issue #328 fifth-round review) needs a
// projectRepo to resolve project.defaultUnitId/defaultBranch — every test
// below sets task.unitId explicitly, so resolveUnitId() never actually falls
// through to this mock's return value, but the dependency itself is now
// required (same reasoning as projectServerRepo/transportFactory above).
function defaultProjectRepo(): Pick<IProjectRepository, 'findById'> {
  return { findById: vi.fn(() => null) };
}

function buildService(opts: {
  window: Window;
  task?: Task | null;
  unit?: Unit | null;
  projectServerRepo?: Pick<IProjectServerRepository, 'find' | 'findByProject'>;
  projectRepo?: Pick<IProjectRepository, 'findById'>;
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
    findByServer: vi.fn(() => []),
    findByServerAndTarget: vi.fn(() => undefined),
    findByServerAndSession: vi.fn(() => []),
    update: vi.fn(),
    updateAgentSessionIdByWindow: vi.fn(),
    remove: vi.fn(),
    removeByServerAndTarget: vi.fn(() => 0),
    updatePaneLayout: vi.fn(),
    now: vi.fn(() => '2026-01-01 00:00:00'),
  };

  const sentCommands: string[] = [];
  const tmux = {
    listSessions: vi.fn(async () => [{ name: 'azito', windowCount: 0, attached: false, created: 0, windows: [] as { name: string; index: number; active: boolean; panes: unknown[]; activity: number }[] }]),
    createSession: vi.fn(async (_server: unknown, _session: string, options?: { windowName?: string; exactName?: boolean }) => ({
      result: { stdout: '', stderr: '', code: 0 },
      windowName: options?.exactName && options.windowName ? options.windowName : `${options?.windowName || 'win'}--rand`,
    })),
    createWindow: vi.fn(async (_server: unknown, _session: string, baseName?: string, options?: { exactName?: boolean }) => ({
      result: { stdout: '', stderr: '', code: 0 },
      windowName: options?.exactName && baseName ? baseName : `${baseName || 'win'}-new`,
    })),
    killWindow: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
    sendKeys: vi.fn(async (_server: unknown, _target: string, keys: string[]) => {
      sentCommands.push(keys[0]);
    }),
    splitPane: vi.fn(async (_server: unknown, _target: string, _direction: 'h' | 'v', _extraEnv?: Record<string, string>) => {}),
    resolvePaneId: vi.fn(async () => '%0'),
    listPaneIds: vi.fn(async () => [{ index: 0, paneId: '%0' }]),
    execCommand: vi.fn(async () => ({ stdout: '' })),
    uiTokenEnv: vi.fn(() => ({ AZITO_UI_TOKEN: 'ui-token-fixture' })),
    // Issue #29 review (5th pass), Critical finding 1: the non-task respawn
    // fallback now calls this server-aware wrapper instead of the
    // server-blind uiTokenEnv() — mirrors it for every existing fixture
    // server (none of which declare isolationIntent).
    uiTokenEnvForServer: vi.fn((_server: ServerConfig) => ({ AZITO_UI_TOKEN: 'ui-token-fixture' })),
  };

  const sessionStrategyFactory = {
    create: vi.fn(() => ({
      supportsSession: true,
      buildRespawnCommand: vi.fn(() => 'claude --resume abc --dangerously-skip-permissions'),
    })),
  };

  const taskRepo: Pick<ITaskRepository, 'findById' | 'updateStatus' | 'update' | 'recordExecutionGateBlock'> = {
    findById: vi.fn(() => opts.task ?? null),
    updateStatus: vi.fn(),
    update: vi.fn(),
    // Mirrors SqliteTaskRepository's real guard (Issue #328 review round):
    // only succeeds while no block is already outstanding on `opts.task`
    // (the same object reference `findById` above always returns, so
    // mutating it here is visible to the next call) — same trick
    // ExecuteTaskUseCase.env.test.ts's taskRepo mock already uses.
    recordExecutionGateBlock: vi.fn((_id: number, fields: { pendingOperation: string; priorStatus: string; pendingOperationWindowId?: number | null }) => {
      if (!opts.task || opts.task.pendingOperation !== null) return false;
      opts.task.status = 'pending_approval' as Task['status'];
      opts.task.pendingOperation = fields.pendingOperation as Task['pendingOperation'];
      opts.task.pendingOperationWindowId = fields.pendingOperationWindowId ?? null;
      opts.task.pendingOperationPriorStatus = fields.priorStatus as Task['pendingOperationPriorStatus'];
      return true;
    }),
  };

  const unitRepo: Pick<IUnitRepository, 'findById'> = {
    findById: vi.fn(() => opts.unit ?? null),
  };

  const clearExitMarker = vi.fn();
  const supervisorRegistry = { clearExitMarker, issueLaunch: vi.fn(() => undefined) } as any;

  const logRepo = { append: vi.fn() } as any;

  // Only needed by resolveExecutionManifest() to resolve the manifest's
  // `sidekick` field (Issue #328 sixth-round review) — returning
  // undefined/null here means that field resolves to nulls, fine for tests
  // that don't exercise it.
  const unitTypeLoader = { get: vi.fn(() => undefined), getOrThrow: vi.fn(() => { throw new Error('not used in tests'); }) } as any;
  const sidekickLoader = { findByName: vi.fn(() => null), findDefaultForTag: vi.fn(() => null), list: vi.fn(() => []) } as any;
  // Used by resolveExecutionManifest() to resolve the manifest's
  // `server`/`secrets` fields (Issue #328 tenth-round review). Issue #29
  // review (7th pass), Important finding 1: ALSO now the lookup
  // createRotatedWindow/createSecondaryWindow's ServerIsolationLock uses to
  // refetch `server` inside the lock — must resolve to a real row (not
  // null) or every respawn() call in this file would throw "Server ...
  // was not found". Returns `makeServer({ name })` for whatever name is
  // queried, which matches every test's own `makeServer()`/`makeServer({...})`
  // call passed directly to `respawn()` on every field this file's fixtures
  // (paneEnvService mocks, tmux mocks) actually inspect — none of them
  // assert on the SPECIFIC server object identity/overrides beyond what
  // `expect.anything()` already tolerates.
  const serverRepo = { findByName: vi.fn((name: string) => makeServer({ name })) } as any;
  const projectSecretRepo = { findByProject: vi.fn(() => []) } as any;
  // Shared task-events EventEmitter (Issue #328 fifteenth-round review) — a
  // real EventEmitter so appendLogAndEmit()'s emit() call is a no-op rather
  // than a crash when no test subscribes to it.
  const events = new EventEmitter();
  // Issue #28 Phase A後半: real TmuxClient.createWindow/createSession
  // extraEnv contents aren't asserted on in this file (see
  // TaskPaneEnvironmentService.test.ts for that) — just needs to return a
  // plausible env Record so respawn()'s task-owned branch has something to
  // pass through.
  const paneEnvService = {
    buildEnvForNewWindow: vi.fn(() => ({
      env: { AZITO_TASK_TOKEN: 'azt.task.1.' + 'a'.repeat(64), AZITO_TASK_ID: '1' },
      tokenId: 5,
    })),
    // Issue #28 multi-window token collision fix: a SECONDARY task window's
    // (re)creation calls this instead — never rotates/issues a task token.
    buildEnvForSecondaryWindow: vi.fn(() => ({ AZITO_TASK_ID: '1' })),
    // Scoped to the specific generation (`tokenId`, mocked as 5 above), not
    // the whole task, per the WindowRotation.ts revokeGeneration fix.
    revokeGeneration: vi.fn(),
    revokeForDestroyedWindow: vi.fn(),
  } as any;

  const service = new WindowRespawnService(
    windowRepo,
    tmux as any,
    sessionStrategyFactory as any,
    taskRepo as any,
    unitRepo as any,
    supervisorRegistry,
    (opts.projectServerRepo ?? defaultProjectServerRepo()) as any,
    (opts.projectRepo ?? defaultProjectRepo()) as any,
    (opts.transportFactory ?? defaultTransportFactory()) as any,
    logRepo,
    unitTypeLoader,
    sidekickLoader,
    serverRepo,
    projectSecretRepo,
    events,
    paneEnvService,
    new KeyedMutex(),
    true,
    undefined,
  );

  return { service, windowRepo, tmux, sentCommands, clearExitMarker, taskRepo, logRepo, serverRepo, projectSecretRepo, events, paneEnvService };
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

  // Issue #28 review Critical finding: `new-window -e`/`new-session -e` only
  // set env for a window's FIRST pane — restorePaneLayout() must pass the
  // SAME task-rotated env to every additional pane it creates via
  // splitPane(), or those panes silently inherit the tmux session's own
  // environment instead (see TmuxClient.splitPane's doc comment and the
  // real-tmux test in TmuxClient.splitPane.tmuxIntegration.test.ts).
  it('passes the task-rotated window env to every splitPane call when restoring a multi-pane task window', async () => {
    const win = makeWindow({
      id: 1,
      taskId: 5,
      windowType: 'agent',
      workerType: 'claude',
      paneLayout: {
        layout: '',
        panes: [
          { index: 0, command: null, workingDirectory: null, title: null },
          { index: 1, command: null, workingDirectory: null, title: null },
          { index: 2, command: null, workingDirectory: null, title: null },
        ],
      },
    });
    const { service, tmux, paneEnvService } = buildService({ window: win, task: makeTask({ id: 5 }) });

    await service.respawn(1, makeServer());

    const rotatedEnv = paneEnvService.buildEnvForNewWindow.mock.results[0].value.env;
    expect(tmux.splitPane).toHaveBeenCalledTimes(2);
    for (const call of tmux.splitPane.mock.calls) {
      expect(call[3]).toBe(rotatedEnv);
    }
  });

  it('passes the legacy uiTokenEnvForServer() to splitPane calls for a non-task multi-pane window', async () => {
    const win = makeWindow({
      id: 1,
      taskId: null,
      windowType: 'terminal',
      workerType: null,
      paneLayout: {
        layout: '',
        panes: [
          { index: 0, command: null, workingDirectory: null, title: null },
          { index: 1, command: null, workingDirectory: null, title: null },
        ],
      },
    });
    const { service, tmux } = buildService({ window: win });

    await service.respawn(1, makeServer());

    expect(tmux.splitPane).toHaveBeenCalledTimes(1);
    // Issue #29 review (5th pass), Critical finding 1: uiTokenEnvForServer()
    // is what the non-task window/pane env is actually built from now — see
    // WindowRespawnService's `windowEnv` assignment (server-aware wrapper
    // around the legacy uiTokenEnv()).
    expect(tmux.splitPane.mock.calls[0][3]).toEqual(tmux.uiTokenEnvForServer(makeServer()));
  });

  // Issue #29 review (9th pass), Important finding 2: createPlainWindow only
  // re-reads the server row AFTER the per-server isolation lock is actually
  // held — if a `PUT /api/servers/:name` isolation transition commits in
  // between `respawn()` being called and that lock being acquired, every
  // downstream tmux call in this turn (pane resolve/restore, and a rollback
  // kill on failure) must use that freshly re-read row, never the `server`
  // argument respawn() was originally called with.
  it('uses the server row re-fetched inside the isolation lock — not the stale server respawn() was called with — for pane resolution, and for the rollback kill on a downstream failure', async () => {
    // Issue #29 review (12th pass), Critical finding 1: differs only on a
    // NON-security field (agentVersion) — a security-relevant difference
    // (isolationIntent, host, ...) is now exactly what createPlainWindow's
    // default `enforceSnapshot` is meant to abort on (see the dedicated test
    // below), so it can no longer stand in for "some field changed" here.
    const staleServer = makeServer({ agentVersion: 'stale-version' });
    const freshServer = makeServer({ agentVersion: 'fresh-version' });
    const win = makeWindow({ id: 1, taskId: null, tmuxTarget: 'azito:task-1--ab12.1' });
    const { service, tmux, serverRepo } = buildService({ window: win });
    // Simulates an unrelated server-row update (e.g. agentVersion bump from
    // an auto-update) committing while this respawn() call was queued for
    // the lock: the row `serverRepo.findByName` returns once the lock is
    // held no longer matches the `staleServer` argument.
    serverRepo.findByName.mockImplementation(() => freshServer);
    tmux.resolvePaneId.mockRejectedValueOnce(new Error('pane resolve failed'));

    await expect(service.respawn(1, staleServer)).rejects.toThrow('pane resolve failed');

    // resolvePaneId (pane resolution, before the failure) got the fresh row.
    expect(tmux.resolvePaneId).toHaveBeenCalledWith(freshServer, expect.any(String));
    expect(tmux.resolvePaneId).not.toHaveBeenCalledWith(staleServer, expect.any(String));
    // The rollback kill triggered by the resolvePaneId failure also got the
    // fresh row, not the stale argument.
    expect(tmux.killWindow).toHaveBeenCalledWith(freshServer, expect.any(String));
    expect(tmux.killWindow).not.toHaveBeenCalledWith(staleServer, expect.any(String));
  });

  // Issue #29 review (12th pass), Critical finding 1: unlike the benign
  // agentVersion-only drift above, a security-relevant field (isolationIntent
  // here) disagreeing between the `server` respawn() was called with and the
  // row actually committed by the time the isolation lock is held must abort
  // the respawn entirely instead of silently continuing against the fresh
  // row — createPlainWindow's default `enforceSnapshot: true` is what
  // enforces this.
  it('aborts (never resolves a pane / creates a window) when the refetched row disagrees on a security field (e.g. isolationIntent) from the one respawn() was called with', async () => {
    const staleServer = makeServer({ isolationIntent: false });
    const freshServer = makeServer({ isolationIntent: true });
    const win = makeWindow({ id: 1, taskId: null, tmuxTarget: 'azito:task-1--ab12.1' });
    const { service, tmux, serverRepo } = buildService({ window: win });
    serverRepo.findByName.mockImplementation(() => freshServer);

    await expect(service.respawn(1, staleServer)).rejects.toThrow(/設定が実行準備中に変更された/);

    expect(tmux.resolvePaneId).not.toHaveBeenCalled();
    expect(tmux.createWindow).not.toHaveBeenCalled();
    expect(tmux.createSession).not.toHaveBeenCalled();
  });
});

// Issue #28 third-party review finding (multi-window token rotation
// collision): a task's AZITO_TASK_TOKEN generation is bound one-to-one to
// its PRIMARY worker window (isPrimary: true, matching task.tmuxWindow) —
// respawning a SECONDARY task-owned window (added via
// POST /api/tasks/:id/windows, isPrimary: false) must neither rotate nor
// revoke that token, or it would 401 the still-live primary pane. Respawning
// the primary window itself must keep rotating exactly as before.
describe('WindowRespawnService.respawn — primary vs. secondary task window token scoping (Issue #28)', () => {
  it('respawning a SECONDARY task window does not rotate the task token, and the primary pane keeps working (masked env only)', async () => {
    const task = makeTask({ id: 5, unitId: 10, tmuxWindow: 'task-5' });
    const unit = makeUnit({ id: 10 });
    const secondaryWin = makeWindow({ id: 2, taskId: 5, isPrimary: false, tmuxTarget: 'azito:task-5-side.1', windowType: 'terminal', workerType: null });
    const { service, tmux, paneEnvService } = buildService({ window: secondaryWin, task, unit });

    await service.respawn(2, makeServer());

    expect(paneEnvService.buildEnvForNewWindow).not.toHaveBeenCalled();
    expect(paneEnvService.buildEnvForSecondaryWindow).toHaveBeenCalledWith(task, expect.anything());
    expect(tmux.createWindow).toHaveBeenCalledWith(
      expect.anything(), 'azito', 'task-5-side', { exactName: true, extraEnv: { AZITO_TASK_ID: '1' } },
    );
  });

  it('respawning a SECONDARY task window does not require confirming the old window is gone as fatal (no token at stake) — a kill failure does not block it', async () => {
    const task = makeTask({ id: 5, unitId: 10 });
    const unit = makeUnit({ id: 10 });
    const secondaryWin = makeWindow({ id: 2, taskId: 5, isPrimary: false, tmuxTarget: 'azito:task-5-side.1', windowType: 'terminal', workerType: null });
    const { service, tmux } = buildService({ window: secondaryWin, task, unit });
    tmux.listSessions.mockResolvedValue([{
      name: 'azito',
      windowCount: 1,
      attached: false,
      created: 0,
      windows: [{ name: 'task-5-side', index: 0, active: true, panes: [], activity: 0 }],
    }]);
    tmux.killWindow.mockRejectedValueOnce(new Error('kill failed'));

    await service.respawn(2, makeServer());

    expect(tmux.createWindow).toHaveBeenCalled();
  });

  it('respawning the PRIMARY task window still rotates the task token as before', async () => {
    const task = makeTask({ id: 5, unitId: 10, tmuxWindow: 'task-5' });
    const unit = makeUnit({ id: 10 });
    const primaryWin = makeWindow({ id: 1, taskId: 5, isPrimary: true, tmuxTarget: 'azito:task-5.1' });
    const { service, paneEnvService } = buildService({ window: primaryWin, task, unit });

    await service.respawn(1, makeServer());

    expect(paneEnvService.buildEnvForNewWindow).toHaveBeenCalledTimes(1);
    expect(paneEnvService.buildEnvForSecondaryWindow).not.toHaveBeenCalled();
  });
});

describe('WindowRespawnService.respawn — execution gate (Issue #328)', () => {
  function untrustedProjectServerRepo(inputPolicy: 'deny' | 'manual-approval'): Pick<IProjectServerRepository, 'find' | 'findByProject'> {
    const row = { projectId: 1, serverName: 'local-server', workingDirectory: null, branch: 'main', tmuxSession: 'azito', inputPolicy, distributeCode: false, distributionRepositoryId: null };
    return {
      find: vi.fn(() => row),
      findByProject: vi.fn(() => [row]),
    };
  }

  it('blocks respawn for an untrusted task denied by policy, before any tmux mutation', async () => {
    const task = makeTask({ id: 5, unitId: 10, inputTrust: 'untrusted' });
    const unit = makeUnit({ id: 10 });
    const win = makeWindow({ taskId: 5, windowType: 'agent', workerType: 'claude' });
    const { service, tmux, windowRepo, logRepo } = buildService({
      window: win, task, unit, projectServerRepo: untrustedProjectServerRepo('deny'),
    });

    await expect(service.respawn(1, makeServer())).rejects.toThrow(/execution denied/);

    expect(tmux.killWindow).not.toHaveBeenCalled();
    expect(tmux.createWindow).not.toHaveBeenCalled();
    expect(tmux.createSession).not.toHaveBeenCalled();
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(windowRepo.update).not.toHaveBeenCalled();
    expect(logRepo.append).toHaveBeenCalledWith(5, 10, 'command', { type: 'execution_gate_blocked', reason: 'denied' });
  });

  it('blocks respawn for an untrusted task pending approval and records pendingOperation + the blocked windowId (Issue #328 fourth-round review)', async () => {
    const task = makeTask({ id: 6, unitId: 10, inputTrust: 'untrusted', executionApprovedFingerprintHash: null });
    const unit = makeUnit({ id: 10 });
    const win = makeWindow({ taskId: 6, windowType: 'agent', workerType: 'claude' });
    const { service, tmux, taskRepo } = buildService({
      window: win, task, unit, projectServerRepo: untrustedProjectServerRepo('manual-approval'),
    });

    await expect(service.respawn(1, makeServer())).rejects.toThrow(/requires approval/);

    expect(tmux.createWindow).not.toHaveBeenCalled();
    // Recording status alone (the old behavior) is not enough: without
    // pendingOperation/pendingOperationWindowId, the approval handler can't
    // tell a blocked respawn apart from a blocked execute()/resume() and
    // resumes the wrong thing (see tasks/execution/ExecutionApprovalDecision.ts's approve-execution).
    expect(taskRepo.recordExecutionGateBlock).toHaveBeenCalledWith(6, {
      pendingOperation: 'respawn',
      priorStatus: 'open',
      manifestHash: expect.any(String),
      pendingOperationWindowId: 1,
    });
  });

  it("emits a 'log' event with a status_change entry on the shared events EventEmitter when a respawn blocks pending approval (Issue #328 fifteenth-round review) — before this, enforceExecutionGate recorded ONLY a 'command' entry, and neither entry ever reached buildServer.ts's NotificationBus/push bridges", async () => {
    const task = makeTask({ id: 6, unitId: 10, inputTrust: 'untrusted', executionApprovedFingerprintHash: null });
    const unit = makeUnit({ id: 10 });
    const win = makeWindow({ taskId: 6, windowType: 'agent', workerType: 'claude' });
    const { service, events } = buildService({
      window: win, task, unit, projectServerRepo: untrustedProjectServerRepo('manual-approval'),
    });
    const received: Array<{ taskId: number; unitId: number; type: string; content: unknown }> = [];
    events.on('log', (entry) => received.push(entry as typeof received[number]));

    await expect(service.respawn(1, makeServer())).rejects.toThrow(/requires approval/);

    const statusChangeEvents = received.filter((e) => e.type === 'status_change');
    expect(statusChangeEvents).toHaveLength(1);
    expect(statusChangeEvents[0]).toMatchObject({
      taskId: 6,
      unitId: 10,
      content: { status: 'pending_approval', operation: 'respawn' },
    });
    expect(received.some((e) => e.type === 'command')).toBe(true);
  });

  it('allows respawn for windows with no taskId regardless of policy', async () => {
    const win = makeWindow({ taskId: null, windowType: 'terminal', workerType: null });
    const { service, tmux } = buildService({
      window: win, projectServerRepo: untrustedProjectServerRepo('deny'),
    });

    await service.respawn(1, makeServer());

    expect(tmux.createWindow).toHaveBeenCalled();
  });
});

describe('WindowRespawnService.respawn — window name preservation', () => {
  it('preserves the original tmux window name on respawn', async () => {
    const win = makeWindow({ tmuxTarget: 'azito:task-1--ab12.1' });
    const { service, windowRepo } = buildService({ window: win });

    const result = await service.respawn(1, makeServer());

    expect(result.tmuxTarget).toBe('azito:task-1--ab12.1');
    expect(windowRepo.update).toHaveBeenCalledWith(1, { tmuxTarget: 'azito:task-1--ab12.1', sleeping: false });
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
      expect.anything(), 'azito', 'task-1--ab12', { exactName: true, extraEnv: { AZITO_UI_TOKEN: 'ui-token-fixture' } },
    );
  });

  it('does not rotate the task token when killing the old window fails, and aborts the respawn (Issue #28 third-party review fix 3)', async () => {
    const task = makeTask({ id: 5, unitId: 10 });
    const unit = makeUnit({ id: 10 });
    const win = makeWindow({ taskId: 5, tmuxTarget: 'azito:task-1--ab12.1' });
    const { service, tmux, paneEnvService } = buildService({ window: win, task, unit });
    tmux.listSessions.mockResolvedValue([{
      name: 'azito',
      windowCount: 1,
      attached: false,
      created: 0,
      windows: [{ name: 'task-1--ab12', index: 0, active: true, panes: [], activity: 0 }],
    }]);
    tmux.killWindow.mockRejectedValueOnce(new Error('kill failed'));

    await expect(service.respawn(1, makeServer())).rejects.toThrow(/task token was not rotated/);

    // The old window's kill attempt failed, so the token must never have
    // been rotated (the old, still-live pane would otherwise be left
    // holding a dead credential) and no replacement window is created.
    expect(paneEnvService.buildEnvForNewWindow).not.toHaveBeenCalled();
    expect(tmux.createWindow).not.toHaveBeenCalled();
    expect(tmux.createSession).not.toHaveBeenCalled();
  });

  it('does not rotate the task token when killing the old window fails on an agent server (resolves with a non-zero code instead of rejecting) — Issue #28 third-party review finding 2', async () => {
    // AgentTransport.execTmux never rejects on the remote tmux command's own
    // exit code — it only rejects on an HTTP-level failure, resolving with
    // whatever ExecResult (including a non-zero code) the agent process
    // returns. A bare `.then(() => true, () => false)` on killWindow's
    // promise previously read this resolve as "kill succeeded" regardless
    // of `code`, so this exact scenario used to rotate the task token and
    // proceed even though the old pane was, in fact, still alive.
    const task = makeTask({ id: 5, unitId: 10 });
    const unit = makeUnit({ id: 10 });
    const win = makeWindow({ taskId: 5, tmuxTarget: 'azito:task-1--ab12.1' });
    const { service, tmux, paneEnvService, serverRepo } = buildService({ window: win, task, unit });
    // buildService()'s default serverRepo.findByName returns
    // makeServer({ name }) (type: 'local') regardless of what is passed to
    // respawn() — this test's own `server` argument is deliberately
    // type: 'agent' (the agent-transport kill-outcome behavior under test),
    // so the mock must match it or the server-snapshot check (Issue #29
    // review, 12th/14th pass) correctly rejects a mismatch before the kill
    // this test is actually about ever runs — see the next test's own
    // identical comment.
    serverRepo.findByName.mockImplementation((name: string) => makeServer({ name, type: 'agent' }));
    tmux.listSessions.mockResolvedValue([{
      name: 'azito',
      windowCount: 1,
      attached: false,
      created: 0,
      windows: [{ name: 'task-1--ab12', index: 0, active: true, panes: [], activity: 0 }],
    }]);
    tmux.killWindow.mockResolvedValueOnce({ stdout: '', stderr: 'client refused connection', code: 1 });

    await expect(service.respawn(1, makeServer({ type: 'agent' }))).rejects.toThrow(/task token was not rotated/);

    expect(paneEnvService.buildEnvForNewWindow).not.toHaveBeenCalled();
    expect(tmux.createWindow).not.toHaveBeenCalled();
    expect(tmux.createSession).not.toHaveBeenCalled();
  });

  // Issue #29 review, 14th pass, Important finding 1: the per-server
  // isolation lock + snapshot check now runs BEFORE the old window is
  // killed, not after (see WindowRotation.ts's withServerLock doc comment).
  // Before this fix, a snapshot mismatch was only discovered once
  // createRotatedWindow's own lock+refetch ran — by which point the old
  // window had already been killed by confirmOldWindowGone, using the
  // (stale) `server` argument this call was made with. This test asserts
  // the corrected ordering directly: with a security-relevant field
  // (isolationIntent) disagreeing between the `server` respawn() was called
  // with and the row actually committed by the time the lock is acquired,
  // the old (still-alive) window must survive untouched — killWindow is
  // never even attempted, and the Window row keeps pointing at it.
  it('aborts BEFORE killing the old window when the refetched row disagrees on a security field (e.g. isolationIntent)', async () => {
    const task = makeTask({ id: 5, unitId: 10 });
    const unit = makeUnit({ id: 10 });
    const win = makeWindow({ id: 1, taskId: 5, tmuxTarget: 'azito:task-1--ab12.1' });
    const { service, tmux, paneEnvService, windowRepo, serverRepo } = buildService({ window: win, task, unit });
    const staleServer = makeServer({ isolationIntent: false });
    const freshServer = makeServer({ isolationIntent: true });
    serverRepo.findByName.mockImplementation(() => freshServer);
    tmux.listSessions.mockResolvedValue([{
      name: 'azito',
      windowCount: 1,
      attached: false,
      created: 0,
      windows: [{ name: 'task-1--ab12', index: 0, active: true, panes: [], activity: 0 }],
    }]);

    await expect(service.respawn(1, staleServer)).rejects.toThrow(/設定が実行準備中に変更された/);

    // The old window was NEVER killed — the snapshot mismatch aborted the
    // whole span before confirmOldWindowGone (which calls killWindow) ever
    // ran.
    expect(tmux.killWindow).not.toHaveBeenCalled();
    // Nothing was rotated or created either.
    expect(paneEnvService.buildEnvForNewWindow).not.toHaveBeenCalled();
    expect(tmux.createWindow).not.toHaveBeenCalled();
    expect(tmux.createSession).not.toHaveBeenCalled();
    // The Window row still points at the original (untouched, still-live)
    // target — never updated to a replacement that was never created.
    expect(windowRepo.update).not.toHaveBeenCalled();
  });

  it('proceeds with rotation when the agent-transport kill resolves with a non-zero code but the window was already gone', async () => {
    const task = makeTask({ id: 5, unitId: 10 });
    const unit = makeUnit({ id: 10 });
    const win = makeWindow({ taskId: 5, tmuxTarget: 'azito:task-1--ab12.1' });
    const { service, tmux, paneEnvService, serverRepo } = buildService({ window: win, task, unit });
    // buildService()'s default serverRepo.findByName returns
    // makeServer({ name }) (type: 'local') regardless of what is passed to
    // respawn() — this test's own `server` argument is deliberately
    // type: 'agent' (the agent-transport kill-outcome behavior under test),
    // so the mock must match it or the new server-snapshot check (Issue #29
    // review, 12th pass, Critical finding 1) correctly rejects a mismatch
    // that was never meant to be under test here.
    serverRepo.findByName.mockImplementation((name: string) => makeServer({ name, type: 'agent' }));
    tmux.listSessions.mockResolvedValue([{
      name: 'azito',
      windowCount: 1,
      attached: false,
      created: 0,
      windows: [{ name: 'task-1--ab12', index: 0, active: true, panes: [], activity: 0 }],
    }]);
    tmux.killWindow.mockResolvedValueOnce({ stdout: '', stderr: "can't find window task-1--ab12", code: 1 });

    await service.respawn(1, makeServer({ type: 'agent' }));

    expect(paneEnvService.buildEnvForNewWindow).toHaveBeenCalledTimes(1);
    expect(tmux.createWindow).toHaveBeenCalled();
  });

  it('revokes the freshly-issued generation when window creation fails after a confirmed kill (Issue #28 third-party review fix 3)', async () => {
    const task = makeTask({ id: 5, unitId: 10 });
    const unit = makeUnit({ id: 10 });
    const win = makeWindow({ taskId: 5, tmuxTarget: 'azito:task-1--ab12.1' });
    const { service, tmux, paneEnvService } = buildService({ window: win, task, unit });
    tmux.listSessions.mockResolvedValue([{
      name: 'azito',
      windowCount: 1,
      attached: false,
      created: 0,
      windows: [{ name: 'task-1--ab12', index: 0, active: true, panes: [], activity: 0 }],
    }]);
    tmux.createWindow.mockRejectedValueOnce(new Error('create failed'));

    await expect(service.respawn(1, makeServer())).rejects.toThrow('create failed');

    // The old window was confirmed killed, so rotation did happen (the new
    // generation is what buildEnvForNewWindow issued) — but since the
    // replacement window never came up, that generation must be revoked
    // rather than left as a live, unused credential.
    expect(paneEnvService.buildEnvForNewWindow).toHaveBeenCalledTimes(1);
    expect(paneEnvService.revokeGeneration).toHaveBeenCalledWith(5, 'respawn_create_failed');
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
      expect.anything(), 'azito', { windowName: 'task-1--ab12', exactName: true, extraEnv: { AZITO_UI_TOKEN: 'ui-token-fixture' } },
    );
    expect(tmux.createWindow).not.toHaveBeenCalled();
    expect(result.tmuxTarget).toBe('azito:task-1--ab12.1');
  });
});

// Issue #28 third-party review Important finding: a pane restore/resolve/
// launch failure AFTER the new window was already created (and, for the
// primary window, its task token already rotated) used to propagate straight
// out of respawn() with no cleanup — leaving that window alive, untracked
// (the DB row still points at the OLD tmuxTarget), and, for the primary
// window, its freshly-issued generation neither killed nor revoked.
describe('WindowRespawnService.respawn — rollback on pane-restore failure (Issue #28)', () => {
  it('kills the new window and revokes the freshly-issued generation when pane setup fails for the PRIMARY task window, then rethrows', async () => {
    const task = makeTask({ id: 5, unitId: 10 });
    const unit = makeUnit({ id: 10 });
    const win = makeWindow({ id: 1, taskId: 5, isPrimary: true, tmuxTarget: 'azito:task-1--ab12.1' });
    const { service, tmux, windowRepo, paneEnvService } = buildService({ window: win, task, unit });
    tmux.resolvePaneId.mockRejectedValueOnce(new Error('pane resolve failed'));

    await expect(service.respawn(1, makeServer())).rejects.toThrow('pane resolve failed');

    // The new window (freshly created) must be killed, not left running
    // untracked.
    expect(tmux.killWindow).toHaveBeenCalledWith(expect.anything(), 'azito:task-1--ab12');
    // Since the kill is confirmed (default mock resolves { code: 0 }), the
    // just-issued generation must be revoked — never left as a live,
    // orphaned credential.
    expect(paneEnvService.revokeGeneration).toHaveBeenCalledWith(5, 'respawn_restore_failed_rollback');
    // The DB row must NOT be updated to point at the now-killed new window.
    expect(windowRepo.update).not.toHaveBeenCalledWith(1, { tmuxTarget: 'azito:task-1--ab12.1' });
  });

  it('persists the new tmuxTarget (keeps it discoverable) instead of revoking, when the post-failure kill itself fails for the PRIMARY window', async () => {
    const task = makeTask({ id: 5, unitId: 10 });
    const unit = makeUnit({ id: 10 });
    const win = makeWindow({ id: 1, taskId: 5, isPrimary: true, tmuxTarget: 'azito:task-1--ab12.1' });
    const { service, tmux, windowRepo, paneEnvService } = buildService({ window: win, task, unit });
    tmux.resolvePaneId.mockRejectedValueOnce(new Error('pane resolve failed'));
    // The default fixture never kills an OLD window here (listSessions
    // reports no matching window, so confirmOldWindowGone is a no-op) —
    // this is the only killWindow call, and it's the rollback kill of the
    // newly-created window, which itself fails (window still alive).
    tmux.killWindow.mockRejectedValueOnce(new Error('rollback kill failed'));

    await expect(service.respawn(1, makeServer())).rejects.toThrow('pane resolve failed');

    // A still-alive orphan must never be silently revoked — the pane would
    // then hold a dead credential while still serving traffic.
    expect(paneEnvService.revokeGeneration).not.toHaveBeenCalled();
    // Instead it stays discoverable: the DB row is updated to the new
    // (still-alive) tmuxTarget so an operator can find and clean it up.
    expect(windowRepo.update).toHaveBeenCalledWith(1, { tmuxTarget: 'azito:task-1--ab12.1' });
  });

  it('kills the new window (no revoke — nothing to revoke) when pane setup fails for a non-task window, then rethrows', async () => {
    const win = makeWindow({ id: 1, taskId: null, tmuxTarget: 'azito:task-1--ab12.1' });
    const { service, tmux, windowRepo, paneEnvService } = buildService({ window: win });
    tmux.resolvePaneId.mockRejectedValueOnce(new Error('pane resolve failed'));

    await expect(service.respawn(1, makeServer())).rejects.toThrow('pane resolve failed');

    expect(tmux.killWindow).toHaveBeenCalledWith(expect.anything(), 'azito:task-1--ab12');
    expect(paneEnvService.revokeGeneration).not.toHaveBeenCalled();
    expect(windowRepo.update).not.toHaveBeenCalledWith(1, { tmuxTarget: 'azito:task-1--ab12.1' });
  });
});

describe('WindowRespawnService.respawn — containment (Issue #27)', () => {
  // Containment resolves real paths via fs.realpath (LocalPathResolver), so
  // these fixtures need to exist on disk — a literal string like '/work'
  // would make every check fail closed with "Cannot verify ... (ENOENT)".
  let rootDir: string;

  function makeProjectServerRepo(workingDirectory: string | null): Pick<IProjectServerRepository, 'find' | 'findByProject'> {
    const row = { projectId: 1, serverName: 'local-server', workingDirectory, branch: 'main', tmuxSession: 'azito', inputPolicy: 'manual-approval' as const, distributeCode: false, distributionRepositoryId: null };
    return { find: vi.fn(() => row), findByProject: vi.fn(() => [row]) };
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

  it('does not kill or recreate the existing window when the path is rejected (destructive ops must follow verification)', async () => {
    // A rejection must abort before any destructive tmux operation or DB
    // write — killing the live window first and only then discovering the
    // resolved path escapes the project root would strand a dead window and
    // a stale-but-persisted tmuxTarget with nothing to show for it.
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'azito-window-respawn-outside-'));
    try {
      const win = makeWindow({ projectId: 1, taskId: null, windowType: 'terminal', workerType: null, workingDirectory: outsideDir });
      const { service, tmux, windowRepo } = buildService({
        window: win,
        projectServerRepo: makeProjectServerRepo(rootDir),
        transportFactory: makeTransportFactory(),
      });
      tmux.listSessions.mockResolvedValue([{
        name: 'azito',
        windowCount: 1,
        attached: false,
        created: 0,
        windows: [{ name: 'task-1', index: 0, active: true, panes: [], activity: 0 }],
      }]);

      await expect(service.respawn(1, makeServer())).rejects.toThrow(/escapes the allowed directory/);

      expect(tmux.killWindow).not.toHaveBeenCalled();
      expect(tmux.createWindow).not.toHaveBeenCalled();
      expect(tmux.createSession).not.toHaveBeenCalled();
      expect(windowRepo.update).not.toHaveBeenCalled();
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('does not kill the existing window when a multi-pane layout path is rejected', async () => {
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
      const { service, tmux, windowRepo } = buildService({
        window: win,
        projectServerRepo: makeProjectServerRepo(rootDir),
        transportFactory: makeTransportFactory(),
      });
      tmux.listSessions.mockResolvedValue([{
        name: 'azito',
        windowCount: 1,
        attached: false,
        created: 0,
        windows: [{ name: 'task-1', index: 0, active: true, panes: [], activity: 0 }],
      }]);

      await expect(service.respawn(1, makeServer())).rejects.toThrow(/escapes the allowed directory/);

      expect(tmux.killWindow).not.toHaveBeenCalled();
      expect(tmux.createWindow).not.toHaveBeenCalled();
      expect(windowRepo.update).not.toHaveBeenCalled();
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

    expect(sentCommands).toContain(`cd -- '${rootDir}'`);
  });

  it('accepts a resolved path containing shell metacharacters and quotes it through to the cd command (Issue #27 review finding 2: containment verification must not restrict the character set — that rejected legitimate directory names like `/srv/repo+tools`; window respawn already sends `cd -- ${shellQuote(cwd)}`, so quoting at that shell boundary is what keeps this safe)', async () => {
    // A directory name with `;`, whitespace, `$(...)`, and a single quote —
    // all legal in a Linux filename — must reach the pane only inside the
    // single-quoted `cd --` argument, never unquoted.
    const dangerousName = `evil; touch pwned; echo $(whoami)'quote`;
    const dangerousDir = path.join(rootDir, dangerousName);
    mkdirSync(dangerousDir);
    const win = makeWindow({ projectId: 1, taskId: null, windowType: 'terminal', workerType: null, workingDirectory: dangerousDir });
    const { service, sentCommands } = buildService({
      window: win,
      projectServerRepo: makeProjectServerRepo(rootDir),
      transportFactory: makeTransportFactory(),
    });

    await service.respawn(1, makeServer());

    expect(sentCommands).toContain(`cd -- '${dangerousDir.replace(/'/g, "'\\''")}'`);
  });

  it('guards a resolved path starting with "-" from being read as a cd option', async () => {
    const dashDir = path.join(rootDir, '-rf');
    mkdirSync(dashDir);
    const win = makeWindow({ projectId: 1, taskId: null, windowType: 'terminal', workerType: null, workingDirectory: dashDir });
    const { service, sentCommands } = buildService({
      window: win,
      projectServerRepo: makeProjectServerRepo(rootDir),
      transportFactory: makeTransportFactory(),
    });

    await service.respawn(1, makeServer());

    expect(sentCommands).toContain(`cd -- '${dashDir}'`);
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

    expect(sentCommands).toContain(`cd -- '${dotDotCacheDir}'`);
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

      expect(sentCommands).toContain(`cd -- '${outsideDir}'`);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('skips verification (legacy behavior) when the caller omits projectServerRepo/transportFactory overrides (default fixture reports no workingDirectory)', async () => {
    // projectServerRepo/transportFactory are now required constructor
    // dependencies (Issue #27 review Minor finding) — this exercises the
    // remaining legitimate skip path (allowedRoot === null because the
    // project has no configured workingDirectory), not an unwired dependency.
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'azito-window-respawn-outside-'));
    try {
      const win = makeWindow({ projectId: 1, taskId: null, windowType: 'terminal', workerType: null, workingDirectory: outsideDir });
      const { service, sentCommands } = buildService({ window: win });

      await service.respawn(1, makeServer());

      expect(sentCommands).toContain(`cd -- '${outsideDir}'`);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('WindowRespawnService.respawn — respawn config fingerprint (Issue #328 eighth-round review finding 2)', () => {
  // Mirrors buildService()'s own default deps (unwired unitTypeLoader/
  // sidekickLoader, no projectServer row) so a hash computed here lines up
  // with the hash the service computes internally during respawn().
  function manifestDeps(unit: Unit | null) {
    return {
      unitRepo: { findById: () => unit } as unknown as IUnitRepository,
      projectRepo: { findById: () => null } as unknown as IProjectRepository,
      projectServerRepo: { find: () => null, findByProject: () => [] } as unknown as IProjectServerRepository,
      // Matches buildService()'s own serverRepo/projectSecretRepo defaults
      // (Issue #328 tenth-round review; Issue #29 review 7th pass, Important
      // finding 1 updated the serverRepo default from `null` to a real
      // `makeServer({ name })` row — see that fix's own comment), so a
      // manifest approved here and one resolved via the real service agree.
      serverRepo: { findByName: (name: string) => makeServer({ name }) } as any,
      projectSecretRepo: { findByProject: () => [] } as any,
      unitTypeLoader: { get: () => undefined, getOrThrow: () => { throw new Error('not used in tests'); } } as any,
      sidekickLoader: { findByName: () => null, findDefaultForTag: () => null, list: () => [] } as any,
    };
  }

  it('a respawn approved for the CURRENT window config does not self-invalidate (top-priority acceptance criterion)', async () => {
    const task = makeTask({ id: 5, unitId: 10, inputTrust: 'untrusted' });
    const unit = makeUnit({ id: 10 });
    const win = makeWindow({ id: 1, taskId: 5, windowType: 'agent', workerType: 'claude', workerModel: 'opus' });

    // 4th arg mirrors WindowRespawnService.enforceExecutionGate's own call
    // (Issue #328 ninth-round review finding 3): the manifest a human
    // approves must be resolved against the WINDOW's server
    // (win.serverName), not whatever resolveTaskServerName alone would
    // produce from the task — respawn() computes its live gate check the
    // same way, via the `server.name` it's actually called with below.
    const { manifest } = resolveExecutionManifest(task, manifestDeps(unit), buildRespawnManifestInput(win), win.serverName);
    const approvedHash = hashExecutionManifest(manifest);
    const approvedTask = { ...task, executionApprovedFingerprintHash: approvedHash };

    const { service, tmux } = buildService({ window: win, task: approvedTask, unit });

    await service.respawn(1, makeServer());

    expect(tmux.sendKeys).toHaveBeenCalled();
  });

  it("a window whose persisted worker config drifted since approval is blocked, not silently respawned with the drifted config (the mismatch this fix closes: approving what task/Unit resolution says vs. what the Window row actually launches)", async () => {
    const task = makeTask({ id: 6, unitId: 10, inputTrust: 'untrusted' });
    const unit = makeUnit({ id: 10 });
    const approvedWin = makeWindow({ id: 1, taskId: 6, windowType: 'agent', workerType: 'claude', workerModel: 'opus' });

    const { manifest } = resolveExecutionManifest(task, manifestDeps(unit), buildRespawnManifestInput(approvedWin), approvedWin.serverName);
    const approvedHash = hashExecutionManifest(manifest);
    const approvedTask = { ...task, executionApprovedFingerprintHash: approvedHash };

    // The Window row persisted since approval now points at a different
    // worker — same task/Unit resolution as before, so the OLD (bugged)
    // manifest would have hashed identically and let this through.
    const driftedWin = { ...approvedWin, workerType: 'codex' };
    const { service, tmux, taskRepo } = buildService({ window: driftedWin, task: approvedTask, unit });

    await expect(service.respawn(1, makeServer())).rejects.toThrow(/requires approval/);

    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(taskRepo.recordExecutionGateBlock).toHaveBeenCalledWith(6, {
      pendingOperation: 'respawn',
      priorStatus: 'open',
      manifestHash: expect.any(String),
      pendingOperationWindowId: 1,
    });
  });

  it('a window respawning on a different server than approved is blocked', async () => {
    const task = makeTask({ id: 7, unitId: 10, inputTrust: 'untrusted' });
    const unit = makeUnit({ id: 10 });
    const approvedWin = makeWindow({ id: 1, taskId: 7, windowType: 'agent', workerType: 'claude', workerModel: 'opus', serverName: 'local-server' });

    const { manifest } = resolveExecutionManifest(task, manifestDeps(unit), buildRespawnManifestInput(approvedWin), approvedWin.serverName);
    const approvedHash = hashExecutionManifest(manifest);
    const approvedTask = { ...task, executionApprovedFingerprintHash: approvedHash };

    const driftedWin = { ...approvedWin, serverName: 'other-server' };
    const { service, taskRepo } = buildService({ window: driftedWin, task: approvedTask, unit });

    await expect(service.respawn(1, makeServer({ name: 'other-server' }))).rejects.toThrow(/requires approval/);
    expect(taskRepo.recordExecutionGateBlock).toHaveBeenCalledWith(7, expect.objectContaining({ pendingOperation: 'respawn' }));
  });
});

describe('WindowRespawnService.respawn — policy resolved from the WINDOW server, not the task server (Issue #328 ninth-round review finding 3)', () => {
  // The task resolves to server A ('manual-approval'), but the Window being
  // respawned actually lives on server B ('deny'). Before this fix,
  // enforceExecutionGate() resolved the project_servers row via the TASK's
  // own server resolution (resolveTaskServerName), ignoring the `server`
  // param respawn() itself was called with — so B's 'deny' was silently
  // overridden by A's more permissive 'manual-approval', and an untrusted
  // respawn onto B could eventually be approved and run despite B's policy.
  function twoServerProjectServerRepo(): Pick<IProjectServerRepository, 'find' | 'findByProject'> {
    const rows: Record<string, { projectId: number; serverName: string; workingDirectory: string | null; branch: string; tmuxSession: string; inputPolicy: 'deny' | 'manual-approval'; distributeCode: boolean; distributionRepositoryId: number | null }> = {
      'server-a': { projectId: 1, serverName: 'server-a', workingDirectory: null, branch: 'main', tmuxSession: 'azito', inputPolicy: 'manual-approval', distributeCode: false, distributionRepositoryId: null },
      'server-b': { projectId: 1, serverName: 'server-b', workingDirectory: null, branch: 'main', tmuxSession: 'azito', inputPolicy: 'deny', distributeCode: false, distributionRepositoryId: null },
    };
    return {
      find: vi.fn((_projectId: number, serverName: string) => rows[serverName] ?? null),
      findByProject: vi.fn(() => Object.values(rows)),
    };
  }

  it("a respawn onto the window's own server (B, deny) is denied even though the task itself resolves to server A (manual-approval)", async () => {
    const task = makeTask({ id: 20, unitId: 10, inputTrust: 'untrusted', serverName: 'server-a' });
    const unit = makeUnit({ id: 10 });
    const win = makeWindow({ id: 1, taskId: 20, windowType: 'agent', workerType: 'claude', serverName: 'server-b' });
    const { service, tmux, taskRepo, logRepo } = buildService({
      window: win, task, unit, projectServerRepo: twoServerProjectServerRepo(),
    });

    await expect(service.respawn(1, makeServer({ name: 'server-b' }))).rejects.toThrow(/execution denied/);

    expect(tmux.killWindow).not.toHaveBeenCalled();
    expect(tmux.createWindow).not.toHaveBeenCalled();
    expect(tmux.createSession).not.toHaveBeenCalled();
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    // Denial never touches task.status/pendingOperation (same as the
    // single-server 'deny' case above) — a bug that instead resolved
    // server A's 'manual-approval' would have called taskRepo.update with
    // pending_approval here instead of throwing outright.
    expect(taskRepo.update).not.toHaveBeenCalled();
    expect(logRepo.append).toHaveBeenCalledWith(20, 10, 'command', { type: 'execution_gate_blocked', reason: 'denied' });
  });

  it("resumeLegacySession also resolves policy from the server it's actually given, not the task's own resolved server", async () => {
    const task = makeTask({ id: 21, unitId: 10, agentSessionId: 'sess-xyz', inputTrust: 'untrusted', serverName: 'server-a' });
    const unit = makeUnit({ id: 10 });
    const win = makeWindow({ taskId: 21 });
    const { service, tmux, taskRepo } = buildService({
      window: win, task, unit, projectServerRepo: twoServerProjectServerRepo(),
    });

    await expect(service.resumeLegacySession(21, makeServer({ name: 'server-b' }))).rejects.toThrow(/execution denied/);

    expect(tmux.createWindow).not.toHaveBeenCalled();
    expect(taskRepo.update).not.toHaveBeenCalled();
  });
});

describe('WindowRespawnService.resumeLegacySession (Issue #328 fourth-round review finding 2)', () => {
  function untrustedProjectServerRepo(inputPolicy: 'deny' | 'manual-approval'): Pick<IProjectServerRepository, 'find' | 'findByProject'> {
    const row = { projectId: 1, serverName: 'local-server', workingDirectory: null, branch: 'main', tmuxSession: 'azito', inputPolicy, distributeCode: false, distributionRepositoryId: null };
    return {
      find: vi.fn(() => row),
      findByProject: vi.fn(() => [row]),
    };
  }

  // Legacy recovery for tasks that predate Window records (migration 034):
  // no Window row exists, so respawn() doesn't apply — this method creates
  // the tmux window and launches `claude --resume` directly. It used to live
  // inline in tasks/routes.ts's recover-session fallback; moved here so the
  // approve-execution handler can resume the exact same blocked operation
  // instead of duplicating the tmux/supervisor wiring.

  it('creates a window and launches a supervised claude --resume for a trusted task', async () => {
    const task = makeTask({ id: 7, unitId: 10, agentSessionId: 'sess-abc', inputTrust: 'trusted' });
    const unit = makeUnit({ id: 10 });
    const win = makeWindow({ taskId: 7 }); // unused by this method, buildService just needs a window to construct the service
    const { service, tmux, sentCommands, clearExitMarker } = buildService({ window: win, task, unit });

    const result = await service.resumeLegacySession(7, makeServer());

    expect(tmux.createWindow).toHaveBeenCalledWith(expect.anything(), 'azito', 'task-7', { extraEnv: expect.objectContaining({ AZITO_TASK_TOKEN: expect.any(String), AZITO_TASK_ID: '1' }) });
    expect(sentCommands).toHaveLength(1);
    expect(sentCommands[0]).toMatch(/supervisor/);
    expect(sentCommands[0]).toContain('claude --resume sess-abc --dangerously-skip-permissions');
    expect(sentCommands[0]).toContain('--task-id 7');
    expect(sentCommands[0]).toContain('--unit-id 10');
    expect(clearExitMarker).toHaveBeenCalled();
    expect(result.windowName).toBe('task-7-new');
  });

  // Issue #29 review (10th pass), Important finding 3: resumeLegacySession's
  // own `resolvePaneId`/`sendKeys` calls (and its rollback's `killWindow`,
  // covered by the sibling describe block below) previously kept using the
  // `server` this method was CALLED with — never the fresher row
  // createRotatedWindow's own lock span re-read via `serverRepo.findByName`
  // — even though every other respawn() branch already did this correctly.
  // Tags each server object via `agentVersion` so the assertion below can
  // tell exactly which one a given tmux call actually received.
  it('uses the server row createRotatedWindow re-read, not the server argument it was called with, for resolvePaneId/sendKeys', async () => {
    const task = makeTask({ id: 7, unitId: 10, agentSessionId: 'sess-abc', inputTrust: 'trusted' });
    const unit = makeUnit({ id: 10 });
    const win = makeWindow({ taskId: 7 });
    const { service, tmux, serverRepo } = buildService({ window: win, task, unit });
    (serverRepo.findByName as ReturnType<typeof vi.fn>).mockImplementation((name: string) => makeServer({ name, agentVersion: 'fresh-from-lock' }));

    await service.resumeLegacySession(7, makeServer({ agentVersion: 'stale-caller-arg' }));

    expect((tmux.resolvePaneId as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ agentVersion: 'fresh-from-lock' });
    expect((tmux.sendKeys as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ agentVersion: 'fresh-from-lock' });
  });

  it('throws when the task has no agent session ID', async () => {
    const task = makeTask({ id: 8, agentSessionId: null });
    const win = makeWindow({ taskId: 8 });
    const { service, tmux } = buildService({ window: win, task });

    await expect(service.resumeLegacySession(8, makeServer())).rejects.toThrow(/agent session ID/);
    expect(tmux.createWindow).not.toHaveBeenCalled();
  });

  it('blocks an untrusted, unapproved task and records pendingOperation=recover_session_legacy (no windowId, unlike respawn)', async () => {
    const task = makeTask({ id: 9, unitId: 10, agentSessionId: 'sess-xyz', inputTrust: 'untrusted', executionApprovedFingerprintHash: null });
    const unit = makeUnit({ id: 10 });
    const win = makeWindow({ taskId: 9 });
    const { service, tmux, taskRepo } = buildService({
      window: win, task, unit, projectServerRepo: untrustedProjectServerRepo('manual-approval'),
    });

    await expect(service.resumeLegacySession(9, makeServer())).rejects.toThrow(/requires approval/);

    expect(tmux.createWindow).not.toHaveBeenCalled();
    expect(taskRepo.recordExecutionGateBlock).toHaveBeenCalledWith(9, {
      pendingOperation: 'recover_session_legacy',
      priorStatus: 'open',
      manifestHash: expect.any(String),
      pendingOperationWindowId: null,
    });
  });

  it("emits a 'log' status_change event for a blocked legacy recover too (Issue #328 fifteenth-round review) — shares enforceExecutionGate() with respawn, so this closes the same gap for the OTHER entry point that method serves", async () => {
    const task = makeTask({ id: 9, unitId: 10, agentSessionId: 'sess-xyz', inputTrust: 'untrusted', executionApprovedFingerprintHash: null });
    const unit = makeUnit({ id: 10 });
    const win = makeWindow({ taskId: 9 });
    const { service, events } = buildService({
      window: win, task, unit, projectServerRepo: untrustedProjectServerRepo('manual-approval'),
    });
    const received: Array<{ taskId: number; unitId: number; type: string; content: unknown }> = [];
    events.on('log', (entry) => received.push(entry as typeof received[number]));

    await expect(service.resumeLegacySession(9, makeServer())).rejects.toThrow(/requires approval/);

    expect(received.filter((e) => e.type === 'status_change')).toEqual([
      expect.objectContaining({ taskId: 9, unitId: 10, content: { status: 'pending_approval', operation: 'recover_session_legacy' } }),
    ]);
  });
});

// Issue #28 third-party review, Important finding 2: resumeLegacySession()
// used to call paneEnvService.buildEnvForNewWindow() + tmux.createWindow()
// directly instead of routing through createRotatedWindow() — a non-zero
// exit code from createWindow() (agent transport) was read as success, and a
// resolvePaneId()/sendKeys() failure after a successful create left an
// untracked window holding a live token generation with nothing rolling it
// back.
describe('WindowRespawnService.resumeLegacySession rollback safety (Issue #28 third-party review finding 2)', () => {
  it('routes window creation through createRotatedWindow: revokes the new generation and does not persist tmuxWindow when createWindow resolves with a non-zero exit code', async () => {
    const task = makeTask({ id: 7, unitId: 10, agentSessionId: 'sess-abc', inputTrust: 'trusted' });
    const unit = makeUnit({ id: 10 });
    const win = makeWindow({ taskId: 7 });
    const { service, tmux, taskRepo, paneEnvService } = buildService({ window: win, task, unit });
    tmux.createWindow.mockResolvedValue({ result: { stdout: '', stderr: 'boom', code: 1 }, windowName: 'task-7-new' });

    await expect(service.resumeLegacySession(7, makeServer())).rejects.toThrow(/Failed to create tmux window/);

    expect(paneEnvService.revokeGeneration).toHaveBeenCalledWith(5, 'resume_legacy_create_failed');
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(taskRepo.update).not.toHaveBeenCalledWith(7, expect.objectContaining({ tmuxWindow: expect.anything() }));
  });

  it('rolls back (kills the window, revokes the new generation) when resolvePaneId fails after a successful createWindow', async () => {
    const task = makeTask({ id: 7, unitId: 10, agentSessionId: 'sess-abc', inputTrust: 'trusted' });
    const unit = makeUnit({ id: 10 });
    const win = makeWindow({ taskId: 7 });
    const { service, tmux, taskRepo, paneEnvService } = buildService({ window: win, task, unit });
    tmux.resolvePaneId.mockRejectedValue(new Error('no such pane'));

    await expect(service.resumeLegacySession(7, makeServer())).rejects.toThrow(/no such pane/);

    expect(tmux.killWindow).toHaveBeenCalledWith(expect.anything(), 'azito:task-7-new');
    expect(paneEnvService.revokeGeneration).toHaveBeenCalledWith(5, 'resume_legacy_launch_failed_rollback');
    expect(taskRepo.update).not.toHaveBeenCalledWith(7, expect.objectContaining({ tmuxWindow: expect.anything() }));
  });

  it('rolls back but does NOT revoke the generation when the rollback kill itself fails (a still-live pane must keep a valid token)', async () => {
    const task = makeTask({ id: 7, unitId: 10, agentSessionId: 'sess-abc', inputTrust: 'trusted' });
    const unit = makeUnit({ id: 10 });
    const win = makeWindow({ taskId: 7 });
    const { service, tmux, paneEnvService } = buildService({ window: win, task, unit });
    tmux.resolvePaneId.mockRejectedValue(new Error('no such pane'));
    tmux.killWindow.mockResolvedValue({ stdout: '', stderr: 'device busy', code: 1 });

    await expect(service.resumeLegacySession(7, makeServer())).rejects.toThrow(/no such pane/);

    expect(paneEnvService.revokeGeneration).not.toHaveBeenCalled();
  });

  // Issue #28 third-party review, second round: the branch above used to
  // leave the just-created window with NO DB reference at all when the
  // rollback kill failed — the window kept running, still holding a valid
  // token, but nothing pointed at it anymore. rollbackWindowReference's
  // onStillAlive callback now persists `tmuxWindow` in that case so the
  // window stays discoverable.
  it('persists tmuxWindow for the still-live window when the rollback kill fails, so it stays discoverable instead of going untracked', async () => {
    const task = makeTask({ id: 7, unitId: 10, agentSessionId: 'sess-abc', inputTrust: 'trusted' });
    const unit = makeUnit({ id: 10 });
    const win = makeWindow({ taskId: 7 });
    const { service, tmux, taskRepo, paneEnvService } = buildService({ window: win, task, unit });
    tmux.resolvePaneId.mockRejectedValue(new Error('no such pane'));
    tmux.killWindow.mockResolvedValue({ stdout: '', stderr: 'device busy', code: 1 });

    await expect(service.resumeLegacySession(7, makeServer())).rejects.toThrow(/no such pane/);

    expect(paneEnvService.revokeGeneration).not.toHaveBeenCalled();
    expect(taskRepo.update).toHaveBeenCalledWith(7, { tmuxWindow: 'task-7-new' });
  });
});

// Phase C round-4 review, Important finding: respawn() used to read
// session/window liveness ONCE, from a `win` snapshot captured before the
// call was even queued behind runExclusiveForTask, and only ran pane
// restoration AFTER the lock released. A second respawn queued behind the
// first still decided "is the old window alive?" from that same
// before-either-call-started snapshot — never re-reading what the FIRST
// respawn had actually just created and persisted. Since createRotatedWindow
// always revokes-then-reissues the task's token generation regardless of
// whether a kill actually happened, the second respawn could revoke the
// first respawn's still-live window's token without ever targeting that
// window for a kill — orphaning it: alive, unreachable, holding a dead
// credential. The fix re-reads the window row (and derives session/window
// names + liveness from it) fresh, INSIDE the same runExclusiveForTask
// callback that also now does pane restoration and the final persist, so
// every respawn for a task owns the window's entire kill-through-restore
// lifecycle atomically before the next queued rotation can begin.
describe('WindowRespawnService.respawn — concurrent respawns for the same task re-read window state inside the lock (Phase C round-4 review)', () => {
  it('serializes two concurrent respawns so the SECOND one kills whatever the FIRST one actually created, leaving exactly one live window (not an orphaned one)', async () => {
    const task = makeTask({ id: 1, unitId: 10, inputTrust: 'trusted' });
    const unit = makeUnit({ id: 10 });

    // Mutable window row: findById always reflects the latest tmuxTarget
    // persisted via update() — unlike buildService()'s default fixture,
    // which always returns the SAME static object regardless of update()
    // calls. This test specifically needs the second queued respawn's fresh
    // re-read to observe what the first one just persisted.
    let windowRow: Window = makeWindow({ id: 1, taskId: 1, ownerType: 'task', isPrimary: true, tmuxTarget: 'sess:win-0.1' });
    const windowRepo: IWindowRepository = {
      add: vi.fn(() => 1),
      findAll: vi.fn(() => []),
      findById: vi.fn(() => windowRow),
      findByProject: vi.fn(() => []),
      findByTask: vi.fn(() => []),
      findByTaskIds: vi.fn(() => new Map()),
      findAgentSessionIdsByServer: vi.fn(() => new Set<string>()),
      findByServer: vi.fn(() => []),
      findByServerAndTarget: vi.fn(() => undefined),
      findByServerAndSession: vi.fn(() => []),
      update: vi.fn((_id: number, fields: Partial<Window>) => {
        windowRow = { ...windowRow, ...fields };
      }),
      updateAgentSessionIdByWindow: vi.fn(),
      remove: vi.fn(),
      removeByServerAndTarget: vi.fn(() => 0),
      updatePaneLayout: vi.fn(),
      now: vi.fn(() => '2026-01-01 00:00:00'),
    };

    // In-memory tmux session/window state, keyed 'sessionName:windowName'.
    // createWindow deliberately returns a NEW, distinct name on every call
    // regardless of the requested `exactName` — simulating a real tmux
    // session where the requested name is still taken by a live window at
    // creation time (the pre-fix race window this test targets). This is
    // what makes staleness observable: a caller that targets the ORIGINAL
    // (pre-respawn) window name for its kill check will miss whatever name
    // the prior respawn's window actually ended up with.
    const aliveWindows = new Set<string>(['sess:win-0']);
    let createCounter = 0;
    const tmux = {
      listSessions: vi.fn(async () => {
        const bySession = new Map<string, string[]>();
        for (const key of aliveWindows) {
          const [s, w] = key.split(':');
          if (!bySession.has(s)) bySession.set(s, []);
          bySession.get(s)!.push(w);
        }
        return Array.from(bySession.entries()).map(([name, windows]) => ({
          name, windowCount: windows.length, attached: false, created: 0,
          windows: windows.map((w, i) => ({ name: w, index: i, active: true, panes: [] as unknown[], activity: 0 })),
        }));
      }),
      createSession: vi.fn(async (_server: unknown, sessionName: string, options?: { windowName?: string }) => {
        createCounter += 1;
        const windowName = `win-${createCounter}`;
        aliveWindows.add(`${sessionName}:${windowName}`);
        return { result: { stdout: '', stderr: '', code: 0 }, windowName };
      }),
      createWindow: vi.fn(async (_server: unknown, sessionName: string) => {
        createCounter += 1;
        const windowName = `win-${createCounter}`;
        aliveWindows.add(`${sessionName}:${windowName}`);
        return { result: { stdout: '', stderr: '', code: 0 }, windowName };
      }),
      killWindow: vi.fn(async (_server: unknown, target: string) => {
        aliveWindows.delete(target);
        return { stdout: '', stderr: '', code: 0 };
      }),
      sendKeys: vi.fn(async () => {}),
      splitPane: vi.fn(async () => {}),
      resolvePaneId: vi.fn(async () => '%0'),
      listPaneIds: vi.fn(async () => [{ index: 0, paneId: '%0' }]),
      execCommand: vi.fn(async () => ({ stdout: '' })),
      uiTokenEnv: vi.fn(() => ({ AZITO_UI_TOKEN: 'ui-token-fixture' })),
      uiTokenEnvForServer: vi.fn(() => ({ AZITO_UI_TOKEN: 'ui-token-fixture' })),
    };

    const sessionStrategyFactory = {
      create: vi.fn(() => ({
        supportsSession: true,
        buildRespawnCommand: vi.fn(() => 'claude --resume abc --dangerously-skip-permissions'),
      })),
    };
    const taskRepo: Pick<ITaskRepository, 'findById' | 'updateStatus' | 'update' | 'recordExecutionGateBlock'> = {
      findById: vi.fn(() => task),
      updateStatus: vi.fn(),
      update: vi.fn(),
      recordExecutionGateBlock: vi.fn(() => false),
    };
    const unitRepo: Pick<IUnitRepository, 'findById'> = { findById: vi.fn(() => unit) };
    const supervisorRegistry = { clearExitMarker: vi.fn(), issueLaunch: vi.fn(() => undefined) } as any;
    const logRepo = { append: vi.fn() } as any;
    const unitTypeLoader = { get: vi.fn(() => undefined), getOrThrow: vi.fn(() => { throw new Error('not used'); }) } as any;
    const sidekickLoader = { findByName: vi.fn(() => null), findDefaultForTag: vi.fn(() => null), list: vi.fn(() => []) } as any;
    // Issue #29 review (7th pass), Important finding 1: must resolve to a
    // real row — see the identical fix (with fuller rationale) on
    // buildService()'s own serverRepo above.
    const serverRepo = { findByName: vi.fn((name: string) => makeServer({ name })) } as any;
    const projectSecretRepo = { findByProject: vi.fn(() => []) } as any;
    const events = new EventEmitter();
    let generationCounter = 0;
    const paneEnvService = {
      buildEnvForNewWindow: vi.fn(() => {
        generationCounter += 1;
        return { env: { AZITO_TASK_TOKEN: 'azt.task.1.' + 'a'.repeat(64), AZITO_TASK_ID: '1' }, tokenId: generationCounter };
      }),
      buildEnvForSecondaryWindow: vi.fn(() => ({ AZITO_TASK_ID: '1' })),
      revokeGeneration: vi.fn(),
      revokeForDestroyedWindow: vi.fn(),
    } as any;

    const service = new WindowRespawnService(
      windowRepo,
      tmux as any,
      sessionStrategyFactory as any,
      taskRepo as any,
      unitRepo as any,
      supervisorRegistry,
      defaultProjectServerRepo() as any,
      defaultProjectRepo() as any,
      defaultTransportFactory() as any,
      logRepo,
      unitTypeLoader,
      sidekickLoader,
      serverRepo,
      projectSecretRepo,
      events,
      paneEnvService,
      new KeyedMutex(),
      true,
      undefined,
    );

    const server = makeServer();
    const results = await Promise.all([
      service.respawn(1, server),
      service.respawn(1, server),
    ]);

    // The core regression assertion: exactly one tmux window is left alive.
    // Under the pre-fix code, the second respawn's stale (captured-before-
    // either-call-started) windowAlive/windowPart pointed at the FIRST
    // respawn's already-superseded window name, so its confirmOldWindowGone
    // check treated that stale name as "already gone" (harmlessly true, but
    // for the wrong window) and never killed what the first respawn had
    // actually just created — while still unconditionally revoking the
    // task's current token generation via createRotatedWindow. That left two
    // windows alive: the first respawn's (orphaned, dead token) and the
    // second's own (freshly created, valid token).
    expect(aliveWindows.size).toBe(1);
    // Both respawns' own kill attempts must have run (each turn correctly
    // detected a live window belonging to this task before creating its
    // own) — not just the first one.
    expect(tmux.killWindow).toHaveBeenCalledTimes(2);
    // The persisted window row and the returned tmuxTarget from the LAST
    // completed respawn both agree with the one truly-alive window.
    const [aliveEntry] = aliveWindows;
    const [aliveSession, aliveWindow] = aliveEntry.split(':');
    expect(windowRow.tmuxTarget).toBe(`${aliveSession}:${aliveWindow}.1`);
    expect(results.map((r) => r.tmuxTarget)).toContain(windowRow.tmuxTarget);
    // Both respawns went through the primary-window token rotation path
    // (each issuing its own generation) — combined with the alive-window and
    // kill-count assertions above, this confirms the second rotation's
    // generation issuance correctly coincided with actually killing the
    // window that held the first one, rather than issuing on top of a
    // window it never touched.
    expect(paneEnvService.buildEnvForNewWindow).toHaveBeenCalledTimes(2);
  });
});

// Issue #29 Step 3a review round, Important findings 1/2: the in-lock
// execution-gate reverify must actually run for legacy recovery, and must
// run BEFORE respawn() kills the primary window it's about to replace — in
// both cases the scenario under test is an 'allow' policy that is still
// valid when the outer (pre-lock) gate decision is made, but has lapsed by
// the time the per-server isolation lock is actually acquired (e.g. a
// concurrent isolation-doctor re-verification committing while this call sat
// queued behind another rotation). `isolationVerifiedAt`/`isolationReport`
// are excluded from `withServerLock`'s own security-snapshot mismatch check
// (see ServerIsolationLock.ts) — changing only those two fields between the
// caller's server snapshot and the lock-acquisition refetch below therefore
// reaches the in-lock reverify itself, not a `ServerSnapshotMismatchError`.
describe('WindowRespawnService — in-lock execution-gate TOCTOU (Issue #29 Step 3a review round)', () => {
  const PASSING_REPORT = JSON.stringify({ kind: 'verification', verified: true });

  function allowProjectServerRepo(): Pick<IProjectServerRepository, 'find' | 'findByProject'> {
    const row = { projectId: 1, serverName: 'local-server', workingDirectory: null, branch: 'main', tmuxSession: 'azito', inputPolicy: 'allow' as const, distributeCode: false, distributionRepositoryId: null };
    return { find: vi.fn(() => row), findByProject: vi.fn(() => [row]) };
  }

  function verifiedServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
    return makeServer({
      isolationIntent: true,
      isolationVerifiedAt: '2026-01-01T00:00:00Z',
      isolationReport: PASSING_REPORT,
      ...overrides,
    });
  }

  it('resumeLegacySession blocks (does not create a window) when the 3-point AND gate degrades between the outer check and the in-lock refetch', async () => {
    const task = makeTask({ id: 9, unitId: 10, agentSessionId: 'sess-xyz', inputTrust: 'untrusted', executionApprovedFingerprintHash: null });
    const unit = makeUnit({ id: 10 });
    const win = makeWindow({ taskId: 9 });
    const { service, tmux, taskRepo, serverRepo } = buildService({
      window: win, task, unit, projectServerRepo: allowProjectServerRepo(),
    });
    // The outer, pre-lock decision (enforceExecutionGate) is made from the
    // `server` argument passed to resumeLegacySession() directly — a fully
    // verified, isolated server, so 'allow' is effective and no block is
    // recorded yet. The in-lock refetch (serverRepo.findByName, used by
    // createRotatedWindow's ServerIsolationLock) returns a row whose
    // verification has since lapsed (isolationVerifiedAt: null) — same
    // isolationIntent, so no snapshot-mismatch abort — which must degrade
    // 'allow' back to 'manual-approval' and block before any window is made.
    serverRepo.findByName.mockImplementation((name: string) => verifiedServer({ name, isolationVerifiedAt: null, isolationReport: null }));

    await expect(service.resumeLegacySession(9, verifiedServer())).rejects.toThrow(/requires approval/);

    expect(tmux.createWindow).not.toHaveBeenCalled();
    expect(tmux.sendKeys).not.toHaveBeenCalled();
    expect(taskRepo.recordExecutionGateBlock).toHaveBeenCalledWith(9, {
      pendingOperation: 'recover_session_legacy',
      priorStatus: 'open',
      manifestHash: expect.any(String),
      pendingOperationWindowId: null,
    });
  });

  it('respawn (PRIMARY task window) blocks BEFORE killing the existing window when the 3-point AND gate degrades between the outer check and the in-lock refetch', async () => {
    const task = makeTask({ id: 5, unitId: 10, inputTrust: 'untrusted', executionApprovedFingerprintHash: null });
    const unit = makeUnit({ id: 10 });
    const win = makeWindow({ id: 1, taskId: 5, isPrimary: true, tmuxTarget: 'azito:task-1--ab12.1' });
    const { service, tmux, taskRepo, windowRepo, serverRepo } = buildService({
      window: win, task, unit, projectServerRepo: allowProjectServerRepo(),
    });
    serverRepo.findByName.mockImplementation((name: string) => verifiedServer({ name, isolationVerifiedAt: null, isolationReport: null }));
    tmux.listSessions.mockResolvedValue([{
      name: 'azito',
      windowCount: 1,
      attached: false,
      created: 0,
      windows: [{ name: 'task-1--ab12', index: 0, active: true, panes: [], activity: 0 }],
    }]);

    await expect(service.respawn(1, verifiedServer())).rejects.toThrow(/requires approval/);

    // The core regression assertion (Important finding 2): the still-live
    // old window must survive untouched — the reverify now runs BEFORE
    // confirmOldWindowGone, not after, so a downgrade discovered here must
    // never reach killWindow at all.
    expect(tmux.killWindow).not.toHaveBeenCalled();
    expect(tmux.createWindow).not.toHaveBeenCalled();
    expect(tmux.createSession).not.toHaveBeenCalled();
    expect(windowRepo.update).not.toHaveBeenCalled();
    expect(taskRepo.recordExecutionGateBlock).toHaveBeenCalledWith(5, {
      pendingOperation: 'respawn',
      priorStatus: 'open',
      manifestHash: expect.any(String),
      pendingOperationWindowId: 1,
    });
  });
});
