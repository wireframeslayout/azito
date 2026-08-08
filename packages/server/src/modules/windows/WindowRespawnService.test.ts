import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { WindowRespawnService, buildRespawnManifestInput } from './WindowRespawnService';
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
    findByServerAndTarget: vi.fn(() => undefined),
    findByServerAndSession: vi.fn(() => []),
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
    splitPane: vi.fn(async () => {}),
    resolvePaneId: vi.fn(async () => '%0'),
    listPaneIds: vi.fn(async () => [{ index: 0, paneId: '%0' }]),
    execCommand: vi.fn(async () => ({ stdout: '' })),
    uiTokenEnv: vi.fn(() => ({ AZITO_UI_TOKEN: 'ui-token-fixture' })),
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
  const supervisorRegistry = { clearExitMarker } as any;

  const logRepo = { append: vi.fn() } as any;

  // Only needed by resolveExecutionManifest() to resolve the manifest's
  // `sidekick` field (Issue #328 sixth-round review) — returning
  // undefined/null here means that field resolves to nulls, fine for tests
  // that don't exercise it.
  const unitTypeLoader = { get: vi.fn(() => undefined), getOrThrow: vi.fn(() => { throw new Error('not used in tests'); }) } as any;
  const sidekickLoader = { findByName: vi.fn(() => null), findDefaultForTag: vi.fn(() => null), list: vi.fn(() => []) } as any;
  // Only needed by resolveExecutionManifest() to resolve the manifest's
  // `server`/`secrets` fields (Issue #328 tenth-round review) — null/empty
  // by default, fine for tests that don't exercise them.
  const serverRepo = { findByName: vi.fn(() => null) } as any;
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
    buildEnvForNewWindow: vi.fn(() => ({ AZITO_TASK_TOKEN: 'azt.task.1.' + 'a'.repeat(64), AZITO_TASK_ID: '1' })),
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
});

describe('WindowRespawnService.respawn — execution gate (Issue #328)', () => {
  function untrustedProjectServerRepo(inputPolicy: 'deny' | 'manual-approval'): Pick<IProjectServerRepository, 'find' | 'findByProject'> {
    const row = { projectId: 1, serverName: 'local-server', workingDirectory: null, branch: 'main', tmuxSession: 'azito', inputPolicy };
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
    const { service, tmux, paneEnvService } = buildService({ window: win, task, unit });
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

  it('proceeds with rotation when the agent-transport kill resolves with a non-zero code but the window was already gone', async () => {
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
    expect(paneEnvService.revokeForDestroyedWindow).toHaveBeenCalledWith(5, 'respawn_create_failed');
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

describe('WindowRespawnService.respawn — containment (Issue #27)', () => {
  // Containment resolves real paths via fs.realpath (LocalPathResolver), so
  // these fixtures need to exist on disk — a literal string like '/work'
  // would make every check fail closed with "Cannot verify ... (ENOENT)".
  let rootDir: string;

  function makeProjectServerRepo(workingDirectory: string | null): Pick<IProjectServerRepository, 'find' | 'findByProject'> {
    const row = { projectId: 1, serverName: 'local-server', workingDirectory, branch: 'main', tmuxSession: 'azito', inputPolicy: 'manual-approval' as const };
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
      // Empty/null by default (Issue #328 tenth-round review) — matches
      // buildService()'s own serverRepo/projectSecretRepo defaults, so a
      // manifest approved here and one resolved via the real service agree.
      serverRepo: { findByName: () => null } as any,
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
    const rows: Record<string, { projectId: number; serverName: string; workingDirectory: string | null; branch: string; tmuxSession: string; inputPolicy: 'deny' | 'manual-approval' }> = {
      'server-a': { projectId: 1, serverName: 'server-a', workingDirectory: null, branch: 'main', tmuxSession: 'azito', inputPolicy: 'manual-approval' },
      'server-b': { projectId: 1, serverName: 'server-b', workingDirectory: null, branch: 'main', tmuxSession: 'azito', inputPolicy: 'deny' },
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
    const row = { projectId: 1, serverName: 'local-server', workingDirectory: null, branch: 'main', tmuxSession: 'azito', inputPolicy };
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
