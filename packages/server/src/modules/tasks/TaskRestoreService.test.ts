import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { TaskRestoreService, type TaskRestoreDeps } from './TaskRestoreService';
import type { Task } from './Task';
import { KeyedMutex } from '../../shared/keyedMutex';

// Containment checks (Issue #27) resolve real paths via fs.realpath, so the
// working directory / worktree path fixtures below must exist on disk —
// literal strings like '/work' would make every containment check reject
// with "Cannot verify ... (ENOENT)" now that TaskRestoreService actually
// verifies them. rootDir is realpath'd immediately so assertions can compare
// against it directly without worrying about tmpdir() itself being a symlink
// (e.g. macOS /tmp -> /private/tmp).
let rootDir: string;
let worktreeDir: string;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    projectId: 10,
    unitId: 20,
    serverName: 'test-server',
    title: 'Test task',
    description: null,
    status: 'archived',
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
    baseBranch: 'main',
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

function makeDeps(overrides: Partial<TaskRestoreDeps> = {}): TaskRestoreDeps {
  return {
    taskRepo: {
      findAll: vi.fn(() => []),
      findByProject: vi.fn(() => []),
      findByUnit: vi.fn(() => []),
      findByStatus: vi.fn(() => []),
      findAgentSessionIdsByServer: vi.fn(() => new Set<string>()),
      findById: vi.fn(() => null),
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
      clearTmuxWindowIfMatches: vi.fn(() => true),
      updateStatusIfWindowMatches: vi.fn(() => true),
    },
    serverRepo: {
      findAll: vi.fn(() => []),
      findByName: vi.fn(() => ({ name: 'test-server', type: 'local' as const, host: '', agentPort: null, agentToken: null, agentVersion: null, sshHost: null, sshHostFingerprint: null, muxRuntime: 'system' as const, isolationIntent: false, isolationVerifiedAt: null, isolationReport: null, isolationCleanupReport: null, createdAt: '2026-01-01' })),
      create: vi.fn(),
      update: vi.fn(),
      updateAgentVersion: vi.fn(),
      updateFingerprint: vi.fn(),
      clearFingerprint: vi.fn(), updateIsolationIntent: vi.fn(),
      delete: vi.fn(),
    },
    projectRepo: {
      findAll: vi.fn(() => []),
      findById: vi.fn(() => ({ id: 10, name: 'Project', slug: 'project', description: null, repositoryUrl: null, defaultBranch: 'main', sidekickPrompt: null, icon: null, color: null, defaultUnitId: 20, servers: [], repositories: [], windows: [], createdAt: '2026-01-01', updatedAt: '2026-01-01' })),
      create: vi.fn(() => 10),
      update: vi.fn(),
      delete: vi.fn(),
      addRepository: vi.fn(() => 1),
      findRepositoryById: vi.fn(() => null),
      updateRepositoryToken: vi.fn(),
      removeRepository: vi.fn(),
      findRepositoryCredentialsByIds: vi.fn(() => []),
    },
    projectServerRepo: {
      findByProject: vi.fn(() => [{ projectId: 10, serverName: 'test-server', workingDirectory: rootDir, branch: 'main', tmuxSession: 'azito', inputPolicy: 'manual-approval' as const, distributeCode: false, distributionRepositoryId: 1 }]),
      findByServer: vi.fn(() => []),
      find: vi.fn(() => ({ projectId: 10, serverName: 'test-server', workingDirectory: rootDir, branch: 'main', tmuxSession: 'azito', inputPolicy: 'manual-approval' as const, distributeCode: false, distributionRepositoryId: 1 })),
      upsert: vi.fn(),
      remove: vi.fn(),
    },
    unitRepo: {
      findAll: vi.fn(() => []),
      findById: vi.fn(() => ({ id: 20, name: 'Unit', unitType: 'devops', systemPrompt: null, selfReviewMaxAttempts: 0, reviewSubagent: null, implementSubagent: null, workerType: 'claude', workerModel: 'claude-opus-4-5', workerExtraArgs: null, workerExecutionMode: 'tmux-pipe' as const, workerRuntime: 'tui' as const, sleepAfterPush: false, phaseConfig: null, createdAt: '2026-01-01', updatedAt: '2026-01-01' })),
      create: vi.fn(() => 20),
      update: vi.fn(),
      delete: vi.fn(),
    },
    windowRepo: {
      add: vi.fn(() => 100),
      findAll: vi.fn(() => []),
      findById: vi.fn(() => undefined),
      findByProject: vi.fn(() => []),
      findByTask: vi.fn(() => []),
      findByTaskIds: vi.fn(() => new Map()),
      findAgentSessionIdsByServer: vi.fn(() => new Set<string>()),
      findByServerAndTarget: vi.fn(() => undefined),
      findByServer: vi.fn(() => []),
      findByServerAndSession: vi.fn(() => []),
      update: vi.fn(),
      updateAgentSessionIdByWindow: vi.fn(),
      remove: vi.fn(),
      removeByServerAndTarget: vi.fn(() => 0),
      updatePaneLayout: vi.fn(),
      now: vi.fn(() => '2026-01-01 00:00:00'),
    },
    tmux: {
      listSessions: vi.fn(async () => [{ name: 'azito', windows: [] }]),
      createSession: vi.fn(async () => ({ result: { stdout: '', stderr: '', code: 0 }, windowName: 'task-1' })),
      createWindow: vi.fn(async () => ({ result: { stdout: '', stderr: '', code: 0 }, windowName: 'task-1' })),
      killWindow: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
      resolvePaneId: vi.fn(async () => '%0'),
      sendKeys: vi.fn(async () => {}),
      checkPaneExists: vi.fn(async () => true),
      uiTokenEnvForServer: vi.fn(() => ({})),
    } as unknown as TaskRestoreDeps['tmux'],
    worktreeServiceFactory: {
      create: vi.fn(() => ({
        create: vi.fn(async () => ({ path: worktreeDir, branch: 'feat/test-task' })),
        remove: vi.fn(async () => {}),
        exists: vi.fn(async () => false),
        getBranch: vi.fn(async () => null),
        getDiff: vi.fn(async () => ''),
        getPrUrl: vi.fn(async () => null),
      })),
    } as unknown as TaskRestoreDeps['worktreeServiceFactory'],
    transportFactory: {
      getTransport: vi.fn(() => ({})),
    } as unknown as TaskRestoreDeps['transportFactory'],
    contentExtractor: {
      extractPlan: vi.fn(async () => ({ planMarkdown: null })),
      extractQuestions: vi.fn(async () => ({ questions: [] })),
      generateSlug: vi.fn(async () => 'test-task'),
    },
    logRepo: {
      append: vi.fn(),
      findByTask: vi.fn(() => []),
      findByUnit: vi.fn(() => []),
    } as unknown as TaskRestoreDeps['logRepo'],
    // Only needed by resolveExecutionManifest() to resolve the manifest's
    // `sidekick` field (Issue #328 sixth-round review) — returning
    // undefined/null here just means that field resolves to nulls, which is
    // fine for tests that don't exercise it.
    unitTypeLoader: {
      get: vi.fn(() => undefined),
      getOrThrow: vi.fn(() => { throw new Error('not used in tests'); }),
      list: vi.fn(() => []),
    } as unknown as TaskRestoreDeps['unitTypeLoader'],
    sidekickLoader: {
      findByName: vi.fn(() => null),
      findDefaultForTag: vi.fn(() => null),
      list: vi.fn(() => []),
    } as unknown as TaskRestoreDeps['sidekickLoader'],
    // Needed by resolveExecutionManifest() to resolve `secrets.namesDigest`
    // (Issue #328 tenth-round review) — empty by default, same rationale as
    // unitTypeLoader/sidekickLoader above.
    projectSecretRepo: {
      findByProject: vi.fn(() => []),
      findByProjectWithValues: vi.fn(() => []),
    } as unknown as TaskRestoreDeps['projectSecretRepo'],
    // Shared task-events EventEmitter (Issue #328 fifteenth-round review) —
    // a real EventEmitter so appendLogAndEmit()'s emit() call is a no-op
    // rather than a crash when no test subscribes to it.
    events: new EventEmitter(),
    // Issue #28 Phase A後半: real TmuxClient.createWindow call args aren't
    // asserted on in this file (see TaskPaneEnvironmentService.test.ts for
    // that) — just needs to return a plausible env Record.
    paneEnvService: {
      buildEnvForNewWindow: vi.fn(() => ({
        env: { AZITO_TASK_TOKEN: 'azt.task.1.' + 'a'.repeat(64), AZITO_TASK_ID: '1' },
        tokenId: 1,
      })),
      // Issue #28 third-party review fix: restore()'s catch-block rollback
      // calls this after successfully killing the freshly-created window —
      // several tests below exercise that rollback path. Scoped to the
      // specific generation (`tokenId`, mocked as 1 above), not the whole
      // task, per the WindowRotation.ts revokeGeneration fix.
      revokeGeneration: vi.fn(),
      revokeForDestroyedWindow: vi.fn(),
    } as unknown as TaskRestoreDeps['paneEnvService'],
    // Issue #29 review (7th pass), Important finding 1: a real KeyedMutex
    // (not a mock) so createRotatedWindow's `withLock` call actually runs
    // its callback synchronously-in-sequence like production, rather than
    // needing every test to special-case a mocked lock.
    serverIsolationMutex: new KeyedMutex(),
    scopedAuthEnabled: true,
    // Distribution not required by default (server.type is 'local' and
    // projectServerRepo's fixture has distributeCode: false) — null exercises
    // performDistribution()'s `{ required: false }` fast path. Tests below
    // that need distribution override this with a real mock.
    fetchDistributionService: null,
    // Issue #87 review (forge/87-mirror follow-up), Important finding 3:
    // null by default (same rationale as `fetchDistributionService` above) —
    // tests exercising `shouldClearRecordedDistributionRepository` wire a
    // real/mocked repo via `overrides`.
    distributionStateRepo: null,
    ...overrides,
  };
}

describe('TaskRestoreService', () => {
  let deps: TaskRestoreDeps;
  let service: TaskRestoreService;
  const log = { warn: vi.fn() };

  beforeEach(() => {
    rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), 'azito-task-restore-')));
    worktreeDir = path.join(rootDir, '.worktrees', 'task-1');
    mkdirSync(worktreeDir, { recursive: true });
    deps = makeDeps();
    service = new TaskRestoreService(deps);
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('restores an archived task: creates session, window, worktree, window row, updates status', async () => {
    const task = makeTask({ serverName: 'test-server' });

    const result = await service.restore(task, log);

    expect(result.tmuxTarget).toBe('azito:task-1.1');
    expect(result.worktreePath).toBe(worktreeDir);
    expect(deps.tmux.createWindow).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'test-server' }),
      'azito',
      'task-1',
      { extraEnv: expect.objectContaining({ AZITO_TASK_TOKEN: expect.any(String), AZITO_TASK_ID: '1' }) },
    );
    expect(deps.windowRepo.add).toHaveBeenCalledWith(expect.objectContaining({
      ownerType: 'task',
      taskId: 1,
      isPrimary: true,
      tmuxTarget: 'azito:task-1.1',
    }));
    expect(deps.taskRepo.update).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'open', tmuxWindow: 'task-1' }));
  });

  it('uses task.branch when available (skips slug generation, passes safe slug)', async () => {
    const task = makeTask({ serverName: 'test-server', branch: 'feat/existing-branch' });

    await service.restore(task, log);

    expect(deps.contentExtractor.generateSlug).not.toHaveBeenCalled();
    const worktreeService = (deps.worktreeServiceFactory.create as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(worktreeService.create).toHaveBeenCalledWith(rootDir, 1, 'task-1', 'main', 'feat/existing-branch');
  });

  it('falls back to task.worktreeBranch when task.branch is null', async () => {
    const task = makeTask({ serverName: 'test-server', branch: null, worktreeBranch: 'feat/worktree-branch' });

    await service.restore(task, log);

    expect(deps.contentExtractor.generateSlug).not.toHaveBeenCalled();
    const worktreeService = (deps.worktreeServiceFactory.create as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(worktreeService.create).toHaveBeenCalledWith(rootDir, 1, 'task-1', 'main', 'feat/worktree-branch');
  });

  it('prefers task.branch over a stale task.worktreeBranch (Issue #328 review round, fix 1) — the branch a restore actually uses must match the branch the approval manifest displayed and fingerprinted', async () => {
    // Regression: an earlier round of this fix preferred worktreeBranch
    // (the SYSTEM-resolved branch from a PRIOR run) over task.branch (the
    // CLIENT-specified value, editable via PUT /api/tasks/:id and the one
    // resolveExecutionManifest()'s `branches.work` field hashes/displays —
    // see ExecutionManifest.ts). Editing an archived task's branch and
    // approving the resulting manifest would then restore into the OLD
    // worktreeBranch, not the branch the human just approved.
    const task = makeTask({
      serverName: 'test-server',
      branch: 'feat/newly-approved-branch',
      worktreeBranch: 'feat/stale-prior-run-branch',
    });

    await service.restore(task, log);

    const worktreeService = (deps.worktreeServiceFactory.create as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(worktreeService.create).toHaveBeenCalledWith(rootDir, 1, 'task-1', 'main', 'feat/newly-approved-branch');
  });

  it('restores into the exact branch the approval manifest fingerprinted (Issue #328 review round) — manifest.branches.work must equal the branch actually passed to worktree creation', async () => {
    const { resolveExecutionManifest } = await import('./execution/ExecutionManifest.js');
    const task = makeTask({
      serverName: 'test-server',
      branch: 'feat/approved-branch',
      worktreeBranch: 'feat/stale-prior-run-branch',
    });

    const { manifest } = resolveExecutionManifest(task, deps, 'continuation');
    await service.restore(task, log);

    const worktreeService = (deps.worktreeServiceFactory.create as ReturnType<typeof vi.fn>).mock.results[0].value;
    const branchActuallyUsed = worktreeService.create.mock.calls[0][4];
    expect(manifest.branches.work).toBe(branchActuallyUsed);
  });

  it('does not write task.branch on restore — the resolved worktree branch goes only into worktreeBranch (Issue #328 review, fourth recurrence of the branch self-invalidation bug)', async () => {
    // Regression: restore() used to also write `branch: worktreeBranch` into
    // the same taskRepo.update() call this test already checks for status/
    // worktreePath/worktreeBranch. Since the approval fingerprint hashes
    // `task.branch` (ExecutionManifest.ts's `branches.work`), that write
    // changed the very fingerprint an approved-but-branch-unspecified task's
    // approval was granted under, the moment restore() ran — self-
    // invalidating the approval it was operating under (see
    // ExecutionManifest.ts's module doc comment for the three earlier
    // recurrences of this exact failure mode).
    const task = makeTask({ serverName: 'test-server', branch: null, worktreeBranch: null });

    await service.restore(task, log);

    // Issue #87 review follow-up, Important finding 4: restore() now ALSO
    // writes an earlier taskRepo.update({ distributionRepositoryId: null })
    // call (this task's server is local, so distribution never runs) —
    // locate the success-path update by its own distinctive field instead of
    // assuming it is the first (or any fixed-index) call.
    const updateCalls = (deps.taskRepo.update as ReturnType<typeof vi.fn>).mock.calls;
    const updateCall = updateCalls.find((c) => (c[1] as Record<string, unknown>).worktreeBranch !== undefined);
    expect(updateCall).toBeDefined();
    expect(updateCall![1]).not.toHaveProperty('branch');
    expect(updateCall![1]).toMatchObject({ worktreeBranch: 'feat/test-task' });
  });

  it('restoring an approved, branch-unspecified task does not change the execution-manifest fingerprint (Issue #328 regression) — re-approval must not be required immediately after a successful restore', async () => {
    const { resolveExecutionManifest, hashExecutionManifest } = await import('./execution/ExecutionManifest.js');
    const task = makeTask({ serverName: 'test-server', branch: null, worktreeBranch: null });

    const hashBefore = hashExecutionManifest(resolveExecutionManifest(task, deps, 'continuation').manifest);

    await service.restore(task, log);

    // Simulate the DB row after restore() by applying every taskRepo.update()
    // call's fields, in order (restore() now issues two: the Issue #87
    // review follow-up Important finding 4 distributionRepositoryId:null
    // write, then the success-path status/worktreePath/worktreeBranch write)
    // — task.branch must be untouched throughout, so re-resolving the
    // manifest off the post-restore row hashes identically.
    const updateCalls = (deps.taskRepo.update as ReturnType<typeof vi.fn>).mock.calls;
    const restoredTask: Task = updateCalls.reduce((acc, c) => ({ ...acc, ...(c[1] as Partial<Task>) }), task);
    const hashAfter = hashExecutionManifest(resolveExecutionManifest(restoredTask, deps, 'continuation').manifest);

    expect(hashAfter).toBe(hashBefore);
  });

  it('passes a non-empty slug even when branch is specified (assertSafeBranch compatibility)', async () => {
    const task = makeTask({ id: 42, serverName: 'test-server', branch: 'feat/my-branch' });

    await service.restore(task, log);

    const worktreeService = (deps.worktreeServiceFactory.create as ReturnType<typeof vi.fn>).mock.results[0].value;
    const slugArg = worktreeService.create.mock.calls[0][2];
    expect(slugArg).toBe('task-42');
    expect(slugArg.length).toBeGreaterThan(0);
  });

  it('rejects a task.workingDirectory that escapes the project working directory (Issue #27)', async () => {
    const outsideDir = mkdtempSync(path.join(tmpdir(), 'azito-task-restore-outside-'));
    try {
      const task = makeTask({ serverName: 'test-server', workingDirectory: outsideDir });

      await expect(service.restore(task, log)).rejects.toThrow(/escapes the allowed directory/);
      expect(deps.worktreeServiceFactory.create).not.toHaveBeenCalled();
      // No worktree was ever created, so rollback should only touch the tmux window.
      expect(deps.tmux.killWindow).toHaveBeenCalled();
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('accepts a child directory named "..cache" (regression: isPathContained must not over-reject)', async () => {
    const dotDotCacheDir = path.join(rootDir, '..cache');
    mkdirSync(dotDotCacheDir);
    const task = makeTask({ serverName: 'test-server', workingDirectory: dotDotCacheDir });
    deps = makeDeps({
      ...deps,
      worktreeServiceFactory: {
        create: vi.fn(() => ({
          create: vi.fn(async (workingDir: string) => ({ path: path.join(workingDir, '.worktrees', 'task-1'), branch: 'feat/test-task' })),
          remove: vi.fn(async () => {}),
        })),
      } as unknown as TaskRestoreDeps['worktreeServiceFactory'],
    });
    mkdirSync(path.join(dotDotCacheDir, '.worktrees', 'task-1'), { recursive: true });
    service = new TaskRestoreService(deps);

    const result = await service.restore(task, log);

    expect(result.worktreePath).toBe(path.join(dotDotCacheDir, '.worktrees', 'task-1'));
  });

  it('uses the resolved worktree path (not the pre-check value) for persistence — TOCTOU-safe (Issue #27)', async () => {
    const task = makeTask({ serverName: 'test-server' });

    const result = await service.restore(task, log);

    // worktreeDir was already created via mkdtempSync -> realpathSync -> mkdirSync,
    // so it carries no symlink indirection here; asserting equality with the
    // resolved value (not a raw string literal) documents that the persisted
    // path is the one assertDirectoryContained returned.
    expect(result.worktreePath).toBe(realpathSync(worktreeDir));
    expect(deps.taskRepo.update).toHaveBeenCalledWith(1, expect.objectContaining({ worktreePath: realpathSync(worktreeDir) }));
  });

  it('skips worktree creation when no workingDir is available', async () => {
    const task = makeTask({ serverName: 'test-server', workingDirectory: null });
    deps = makeDeps({
      ...deps,
      projectServerRepo: {
        ...deps.projectServerRepo,
        find: vi.fn(() => ({ projectId: 10, serverName: 'test-server', workingDirectory: null, branch: null, tmuxSession: 'azito', inputPolicy: 'manual-approval' as const, distributeCode: false, distributionRepositoryId: null })),
      },
    });
    service = new TaskRestoreService(deps);

    const result = await service.restore(task, log);

    expect(result.worktreePath).toBeNull();
    expect(deps.worktreeServiceFactory.create).not.toHaveBeenCalled();
  });

  it('rolls back tmux window on worktree creation failure', async () => {
    const task = makeTask({ serverName: 'test-server' });
    deps = makeDeps({
      ...deps,
      worktreeServiceFactory: {
        create: vi.fn(() => ({
          create: vi.fn(async () => { throw new Error('worktree failed'); }),
          remove: vi.fn(async () => {}),
        })),
      } as unknown as TaskRestoreDeps['worktreeServiceFactory'],
    });
    service = new TaskRestoreService(deps);

    await expect(service.restore(task, log)).rejects.toThrow('worktree failed');
    expect(deps.tmux.killWindow).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'test-server' }),
      'azito:task-1',
    );
    // Issue #28 third-party review fix: the task stays 'archived' throughout
    // this rollback (no status WRITE happens here to trigger
    // TOKEN_REVOKING_STATUSES again), so the generation this restore()
    // attempt just issued via buildEnvForNewWindow would otherwise leak —
    // revoke it directly once the kill above is confirmed.
    expect(deps.paneEnvService.revokeGeneration).toHaveBeenCalledWith(1, 'restore_rollback');
  });

  it('throws when tmux window creation fails and task remains archived', async () => {
    const task = makeTask({ serverName: 'test-server' });
    deps = makeDeps({
      ...deps,
      tmux: {
        ...deps.tmux,
        createWindow: vi.fn(async () => { throw new Error('tmux failed'); }),
      } as unknown as TaskRestoreDeps['tmux'],
    });
    service = new TaskRestoreService(deps);

    await expect(service.restore(task, log)).rejects.toThrow('tmux failed');
    expect(deps.taskRepo.update).not.toHaveBeenCalled();
    // Issue #28 Phase A last-round fix: restore() now creates the window via
    // WindowRotation.createRotatedWindow() instead of calling
    // buildEnvForNewWindow()+tmux.createWindow() directly — the direct-call
    // form assigned `windowName` only after creation resolved, so a thrown
    // creation failure skipped restore()'s own `if (windowName)` rollback
    // below and left the freshly-issued generation valid with no window
    // backing it. createRotatedWindow revokes the just-issued generation
    // itself before rethrowing, so the revoke must still happen here even
    // though nothing was ever created (no window to kill — killWindow must
    // NOT be called for a window that never came into existence).
    expect(deps.paneEnvService.revokeGeneration).toHaveBeenCalledWith(1, 'restore_create_failed');
    expect(deps.tmux.killWindow).not.toHaveBeenCalled();
  });

  it('throws and revokes the just-issued generation when tmux window creation resolves with a non-zero exit code (agent-transport failure mode)', async () => {
    // Issue #28 Phase A last-round fix: an agent-transport
    // TmuxClient.createWindow() never rejects on the remote command's own
    // exit code — it resolves with `{ result: { code !== 0 }, windowName }`.
    // Before routing through createRotatedWindow(), restore() ignored
    // `result.code` entirely and treated ANY resolved call as success,
    // persisting a window row/task update for a window that was never
    // actually created.
    const task = makeTask({ serverName: 'test-server' });
    deps = makeDeps({
      ...deps,
      tmux: {
        ...deps.tmux,
        createWindow: vi.fn(async () => ({ result: { stdout: '', stderr: 'no server running', code: 1 }, windowName: 'task-1' })),
      } as unknown as TaskRestoreDeps['tmux'],
    });
    service = new TaskRestoreService(deps);

    await expect(service.restore(task, log)).rejects.toThrow(/Failed to create tmux window/);
    expect(deps.taskRepo.update).not.toHaveBeenCalled();
    expect(deps.windowRepo.add).not.toHaveBeenCalled();
    expect(deps.paneEnvService.revokeGeneration).toHaveBeenCalledWith(1, 'restore_create_failed');
    expect(deps.tmux.killWindow).not.toHaveBeenCalled();
  });

  // Issue #28 third-party review, second round: TaskRestoreService's rollback
  // used to remove the Window row (and, before that, clear the DB reference
  // in ExecuteTaskUseCase's siblings) regardless of whether the rollback kill
  // itself actually succeeded — a kill failure left a still-live,
  // still-token-authenticated window with no DB row left pointing at it. The
  // 3 sites now share WindowRotation.rollbackWindowReference, which only
  // clears/removes the reference once the kill is confirmed.
  it('does not revoke the generation when the rollback kill fails during worktree-creation-failure rollback (a still-live pane must keep a valid token)', async () => {
    const task = makeTask({ serverName: 'test-server' });
    deps = makeDeps({
      ...deps,
      worktreeServiceFactory: {
        create: vi.fn(() => ({
          create: vi.fn(async () => { throw new Error('worktree failed'); }),
          remove: vi.fn(async () => {}),
        })),
      } as unknown as TaskRestoreDeps['worktreeServiceFactory'],
      tmux: {
        ...deps.tmux,
        killWindow: vi.fn(async () => ({ stdout: '', stderr: 'device busy', code: 1 })),
      } as unknown as TaskRestoreDeps['tmux'],
    });
    service = new TaskRestoreService(deps);

    await expect(service.restore(task, log)).rejects.toThrow('worktree failed');
    expect(deps.tmux.killWindow).toHaveBeenCalled();
    expect(deps.paneEnvService.revokeGeneration).not.toHaveBeenCalled();
  });

  it('does not remove the Window row when the rollback kill fails after the row was already persisted — the still-live window must stay discoverable', async () => {
    const task = makeTask({ serverName: 'test-server' });
    deps = makeDeps({
      ...deps,
      taskRepo: {
        ...deps.taskRepo,
        // Forces restore()'s final success-path taskRepo.update (after
        // windowRepo.add has already run) to throw, so the outer catch runs
        // with windowRowId already set — the scenario the fix targets.
        update: vi.fn((_id: number, fields: Record<string, unknown>) => {
          // Issue #87 review follow-up, Important finding 4: restore() now
          // ALSO writes distributionRepositoryId:null unconditionally right
          // after performDistribution (this task's server is local, so
          // distribution never runs) — that earlier write must succeed so
          // this mock can still target the LATER success-path update this
          // test actually exercises.
          if ('distributionRepositoryId' in fields) return;
          throw new Error('db write failed');
        }),
      },
      tmux: {
        ...deps.tmux,
        killWindow: vi.fn(async () => ({ stdout: '', stderr: 'device busy', code: 1 })),
      } as unknown as TaskRestoreDeps['tmux'],
    });
    service = new TaskRestoreService(deps);

    await expect(service.restore(task, log)).rejects.toThrow('db write failed');
    expect(deps.windowRepo.add).toHaveBeenCalled();
    expect(deps.tmux.killWindow).toHaveBeenCalled();
    expect(deps.windowRepo.remove).not.toHaveBeenCalled();
    expect(deps.paneEnvService.revokeGeneration).not.toHaveBeenCalled();
  });

  it('removes the Window row and revokes the generation when the rollback kill succeeds after the row was already persisted', async () => {
    const task = makeTask({ serverName: 'test-server' });
    deps = makeDeps({
      ...deps,
      taskRepo: {
        ...deps.taskRepo,
        update: vi.fn((_id: number, fields: Record<string, unknown>) => {
          // Issue #87 review follow-up, Important finding 4: restore() now
          // ALSO writes distributionRepositoryId:null unconditionally right
          // after performDistribution (this task's server is local, so
          // distribution never runs) — that earlier write must succeed so
          // this mock can still target the LATER success-path update this
          // test actually exercises.
          if ('distributionRepositoryId' in fields) return;
          throw new Error('db write failed');
        }),
      },
    });
    service = new TaskRestoreService(deps);

    await expect(service.restore(task, log)).rejects.toThrow('db write failed');
    expect(deps.windowRepo.add).toHaveBeenCalled();
    expect(deps.windowRepo.remove).toHaveBeenCalledWith(100);
    expect(deps.paneEnvService.revokeGeneration).toHaveBeenCalledWith(1, 'restore_rollback');
  });

  it('throws when server cannot be resolved', async () => {
    const task = makeTask({ serverName: null });
    deps = makeDeps({
      ...deps,
      projectServerRepo: {
        ...deps.projectServerRepo,
        findByProject: vi.fn(() => []),
      },
    });
    service = new TaskRestoreService(deps);

    await expect(service.restore(task, log)).rejects.toThrow('Cannot resolve server');
  });

  it('creates tmux session when it does not exist', async () => {
    const task = makeTask({ serverName: 'test-server' });
    deps = makeDeps({
      ...deps,
      tmux: {
        ...deps.tmux,
        listSessions: vi.fn(async () => []),
        createSession: vi.fn(async () => ({ result: { stdout: '', stderr: '', code: 0 }, windowName: 'w' })),
        createWindow: vi.fn(async () => ({ result: { stdout: '', stderr: '', code: 0 }, windowName: 'task-1' })),
      } as unknown as TaskRestoreDeps['tmux'],
    });
    service = new TaskRestoreService(deps);

    await service.restore(task, log);

    expect(deps.tmux.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'test-server' }),
      'azito',
      { extraEnv: {} },
    );
  });

  // Issue #29 review (10th pass): Critical finding 1 (session bootstrap must
  // run inside the isolation lock, against a freshly re-read server) and
  // Important finding 3 (the fresh `server` createRotatedWindow returns must
  // be used for everything downstream, not the `server` argument it was
  // called with) — this test gives serverRepo.findByName a distinct
  // ServerConfig object on every call (tagged via `agentVersion`, an
  // otherwise-unused field here) to prove every server-carrying call this
  // function makes AFTER a given lock-and-refetch actually received THAT
  // refetch's object, not an earlier one.
  it('uses the server row re-read inside each isolation-lock span for every subsequent tmux/transport call, not the server resolved before restore() started', async () => {
    const task = makeTask({ serverName: 'test-server' });
    let generation = 0;
    const findByName = vi.fn(() => {
      generation += 1;
      return {
        name: 'test-server', type: 'local' as const, host: '', agentPort: null, agentToken: null,
        // Tag each returned row with the call count so assertions below can
        // tell exactly which generation a given tmux/transport call saw.
        agentVersion: `gen-${generation}`,
        sshHost: null, sshHostFingerprint: null, muxRuntime: 'system' as const,
        isolationIntent: false, isolationVerifiedAt: null, isolationReport: null, isolationCleanupReport: null, createdAt: '2026-01-01',
      };
    });
    deps = makeDeps({
      ...deps,
      serverRepo: { ...deps.serverRepo, findByName },
      tmux: {
        ...deps.tmux,
        listSessions: vi.fn(async () => []),
        createSession: vi.fn(async () => ({ result: { stdout: '', stderr: '', code: 0 }, windowName: 'azito' })),
        createWindow: vi.fn(async () => ({ result: { stdout: '', stderr: '', code: 0 }, windowName: 'task-1' })),
      } as unknown as TaskRestoreDeps['tmux'],
    });
    service = new TaskRestoreService(deps);

    await service.restore(task, log);

    // findByName is called once at the top of restore() (serverAtStart),
    // once inside resolveExecutionManifest() for the execution-gate
    // manifest, then once per lock-and-refetch span below — so
    // createSession/resolvePaneId/getTransport must each see whichever
    // generation its OWN span produced, never an earlier one.
    const createSessionServer = (deps.tmux.createSession as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const resolvePaneIdServer = (deps.tmux.resolvePaneId as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const getTransportServer = (deps.transportFactory.getTransport as ReturnType<typeof vi.fn>).mock.calls[0][0];

    // ensureSessionWithLock's own lock span re-read the server for the
    // session bootstrap — createSession must see that row, not the one
    // resolved at the very top of restore() or inside resolveExecutionManifest().
    expect(createSessionServer.agentVersion).not.toBe('gen-1');
    // createRotatedWindow's own, LATER lock span re-read the server again
    // for the real task window — resolvePaneId/getTransport (called after,
    // with the reassigned `server`) must see that STRICTLY NEWER row, not
    // the one ensureSessionWithLock's span produced.
    expect(resolvePaneIdServer.agentVersion).not.toBe(createSessionServer.agentVersion);
    expect(getTransportServer.agentVersion).toBe(resolvePaneIdServer.agentVersion);
  });

  // Issue #87 13th-round review, Important finding 1: restore() must run
  // the same fetch-distribution check execute() does before recreating a
  // task's worktree — an isolated server or a distribute_code project
  // server restored from an archived task must not silently rebuild its
  // worktree from whatever stale local content happens to already be at
  // workingDir.
  describe('fetch distribution (Issue #87 13th-round review, Important finding 1)', () => {
    function mockFetchDistributionService(overrides: Record<string, any> = {}) {
      return {
        // Issue #87 review (forge/87-mirror follow-up), Important finding 2
        // (third round): the record-write callback (`onBeforeDistribute`,
        // threaded through as `params.onBeforeWorkingDirChange`) now fires
        // from INSIDE `distribute()`, immediately before the local working
        // directory is touched — not by `performDistribution()` itself
        // before calling `distribute()` at all. This fake must call it too,
        // exactly like the real `FetchDistributionService.distributeUnlocked()`
        // does right before its `ensureWorkingDir()` calls, or every test
        // below that asserts `taskRepo.update({ distributionRepositoryId })`
        // was written would falsely fail.
        distribute: vi.fn(async (params: { onBeforeWorkingDirChange?: () => void }) => {
          params.onBeforeWorkingDirChange?.();
          return { status: 'distributed', sha: 'a'.repeat(40), bundleType: 'full', localBranchSynced: true };
        }),
        ...overrides,
      } as unknown as NonNullable<TaskRestoreDeps['fetchDistributionService']>;
    }

    // agent/ssh servers route worktree-path containment through
    // PathResolverFactory's RemotePathResolver, which shells out via
    // `transport.exec('cd -- <path> && pwd -P')` — echo the requested path
    // straight back (it's already a real, existing directory: `worktreeDir`)
    // so the containment check these tests don't otherwise care about
    // doesn't throw.
    function agentTransportFactory(): TaskRestoreDeps['transportFactory'] {
      return {
        getTransport: vi.fn(() => ({
          exec: vi.fn(async (cmd: string) => {
            const match = /^cd -- (.+) && pwd -P$/.exec(cmd);
            const rawPath = match ? match[1] : worktreeDir;
            const unquoted = rawPath.startsWith("'") ? rawPath.slice(1, -1).replace(/'\\''/g, "'") : rawPath;
            return { stdout: `${unquoted}\n`, stderr: '', code: 0 };
          }),
        })),
      } as unknown as TaskRestoreDeps['transportFactory'];
    }

    function withRepository(projectRepo: TaskRestoreDeps['projectRepo']) {
      (projectRepo.findById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 10, name: 'Project', slug: 'project', description: null, repositoryUrl: null, defaultBranch: 'main',
        sidekickPrompt: null, icon: null, color: null, defaultUnitId: 20,
        repositories: [{ id: 1, name: 'repo', url: 'https://github.com/acme/repo.git', provider: 'github' as const, owner: 'acme', repoName: 'repo', hasToken: true }],
        windows: [], createdAt: '2026-01-01', updatedAt: '2026-01-01',
      });
      (projectRepo.findRepositoryById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 1, name: 'repo', url: 'https://github.com/acme/repo.git', provider: 'github' as const, owner: 'acme', repoName: 'repo', token: 'dummy-token',
      });
    }

    it('runs fetch distribution before worktree creation on an isolated server, and fails the restore when it fails', async () => {
      const fetchDistributionService = mockFetchDistributionService({
        distribute: vi.fn(async () => ({ status: 'failed', error: 'dummy distribution failure' })),
      });
      withRepository(deps.projectRepo);
      deps = makeDeps({
        ...deps,
        fetchDistributionService,
        transportFactory: agentTransportFactory(),
        serverRepo: {
          ...deps.serverRepo,
          findByName: vi.fn(() => ({ name: 'test-server', type: 'agent' as const, host: 'host-a', agentPort: 4021, agentToken: null, agentVersion: null, sshHost: null, sshHostFingerprint: null, muxRuntime: 'system' as const, isolationIntent: true, isolationVerifiedAt: null, isolationReport: null, isolationCleanupReport: null, createdAt: '2026-01-01' })),
        },
      });
      service = new TaskRestoreService(deps);
      const task = makeTask({ serverName: 'test-server' });

      await expect(service.restore(task, log)).rejects.toThrow(/Fetch distribution failed/);

      expect(fetchDistributionService.distribute).toHaveBeenCalled();
      // Distribution failed before worktree creation was ever reached — the
      // worktree service factory itself was never invoked.
      expect(deps.worktreeServiceFactory.create).not.toHaveBeenCalled();
      // The tmux window this run created is rolled back, same as this
      // function's existing failure-handling convention for worktree
      // creation failures.
      expect(deps.tmux.killWindow).toHaveBeenCalled();
    });

    it('succeeds and creates the worktree once distribution succeeds on an isolated server', async () => {
      const fetchDistributionService = mockFetchDistributionService();
      withRepository(deps.projectRepo);
      deps = makeDeps({
        ...deps,
        fetchDistributionService,
        transportFactory: agentTransportFactory(),
        serverRepo: {
          ...deps.serverRepo,
          findByName: vi.fn(() => ({ name: 'test-server', type: 'agent' as const, host: 'host-a', agentPort: 4021, agentToken: null, agentVersion: null, sshHost: null, sshHostFingerprint: null, muxRuntime: 'system' as const, isolationIntent: true, isolationVerifiedAt: null, isolationReport: null, isolationCleanupReport: null, createdAt: '2026-01-01' })),
        },
      });
      service = new TaskRestoreService(deps);
      const task = makeTask({ serverName: 'test-server' });

      const result = await service.restore(task, log);

      expect(fetchDistributionService.distribute).toHaveBeenCalled();
      expect(result.worktreePath).toBe(worktreeDir);
      const worktreeService = (deps.worktreeServiceFactory.create as ReturnType<typeof vi.fn>).mock.results[0]?.value;
      expect(worktreeService?.create).toHaveBeenCalled();
    });

    // Issue #87 review follow-up, Important finding 1: restore() must
    // persist the repository distribution actually pulled from, the same
    // way execute() does — see Task.distributionRepositoryId's doc comment.
    // A later resumeStateMachine() call must use this recorded value
    // instead of re-resolving from the project/project-server's THEN-
    // current configuration.
    it('records the resolved repository id onto the task once distribution succeeds', async () => {
      const fetchDistributionService = mockFetchDistributionService();
      withRepository(deps.projectRepo);
      deps = makeDeps({
        ...deps,
        fetchDistributionService,
        transportFactory: agentTransportFactory(),
        serverRepo: {
          ...deps.serverRepo,
          findByName: vi.fn(() => ({ name: 'test-server', type: 'agent' as const, host: 'host-a', agentPort: 4021, agentToken: null, agentVersion: null, sshHost: null, sshHostFingerprint: null, muxRuntime: 'system' as const, isolationIntent: true, isolationVerifiedAt: null, isolationReport: null, isolationCleanupReport: null, createdAt: '2026-01-01' })),
        },
      });
      service = new TaskRestoreService(deps);
      const task = makeTask({ serverName: 'test-server' });

      await service.restore(task, log);

      expect(deps.taskRepo.update).toHaveBeenCalledWith(task.id, expect.objectContaining({ distributionRepositoryId: 1 }));
    });

    // Issue #87 review (forge/87-mirror follow-up), Important finding 2
    // (third round): the record-write callback is threaded through
    // `performDistribution()` -> `fetchDistributionService.distribute()` as
    // `onBeforeWorkingDirChange`, NOT invoked by `performDistribution()`
    // itself before `distribute()` is even called (the previous round's
    // fix, which this one supersedes — see DistributionHelper.ts's
    // `onBeforeDistribute` doc comment). This asserts the wiring:
    // `distribute()` is called WITH the callback, and invoking it (as the
    // mock does, right before it "succeeds") is what actually produces the
    // taskRepo write.
    it('threads the record-write callback into distribute() as onBeforeWorkingDirChange, rather than firing it before distribute() is even called', async () => {
      const fetchDistributionService = mockFetchDistributionService();
      withRepository(deps.projectRepo);
      deps = makeDeps({
        ...deps,
        fetchDistributionService,
        transportFactory: agentTransportFactory(),
        serverRepo: {
          ...deps.serverRepo,
          findByName: vi.fn(() => ({ name: 'test-server', type: 'agent' as const, host: 'host-a', agentPort: 4021, agentToken: null, agentVersion: null, sshHost: null, sshHostFingerprint: null, muxRuntime: 'system' as const, isolationIntent: true, isolationVerifiedAt: null, isolationReport: null, isolationCleanupReport: null, createdAt: '2026-01-01' })),
        },
      });
      service = new TaskRestoreService(deps);
      const task = makeTask({ serverName: 'test-server' });

      await service.restore(task, log);

      expect(fetchDistributionService.distribute).toHaveBeenCalledWith(
        expect.objectContaining({ onBeforeWorkingDirChange: expect.any(Function) }),
      );
      expect(deps.taskRepo.update).toHaveBeenCalledWith(task.id, expect.objectContaining({ distributionRepositoryId: 1 }));
    });

    // Issue #87 review (forge/87-mirror follow-up), Important finding 2
    // (third round), superseding the prior "still records the attempted
    // distributionRepositoryId even when fetch distribution fails" test:
    // `distribute()` can fail BEFORE ever reaching the working-directory
    // mutation step (resolving sshHost's home directory, preparing the
    // hub's repo cache, transferring the bundle onto the remote mirror —
    // see FetchDistributionService.distribute()/distributeUnlocked()). A
    // failure at any of those stages means `onBeforeWorkingDirChange` never
    // fires, so the record must NOT be written — the working directory was
    // never touched this run, so a PRIOR run's accurate record (if any)
    // must survive untouched. This fake models exactly that: `distribute()`
    // fails without ever calling `onBeforeWorkingDirChange`.
    it('does NOT record a distributionRepositoryId when fetch distribution fails before ever calling onBeforeWorkingDirChange (i.e. before touching the working directory)', async () => {
      const fetchDistributionService = mockFetchDistributionService({
        distribute: vi.fn(async () => ({ status: 'failed', error: 'dummy distribution failure' })),
      });
      withRepository(deps.projectRepo);
      deps = makeDeps({
        ...deps,
        fetchDistributionService,
        transportFactory: agentTransportFactory(),
        serverRepo: {
          ...deps.serverRepo,
          findByName: vi.fn(() => ({ name: 'test-server', type: 'agent' as const, host: 'host-a', agentPort: 4021, agentToken: null, agentVersion: null, sshHost: null, sshHostFingerprint: null, muxRuntime: 'system' as const, isolationIntent: true, isolationVerifiedAt: null, isolationReport: null, isolationCleanupReport: null, createdAt: '2026-01-01' })),
        },
      });
      service = new TaskRestoreService(deps);
      const task = makeTask({ serverName: 'test-server' });

      await expect(service.restore(task, log)).rejects.toThrow(/Fetch distribution failed/);

      expect(fetchDistributionService.distribute).toHaveBeenCalled();
      expect(deps.taskRepo.update).not.toHaveBeenCalledWith(task.id, expect.objectContaining({ distributionRepositoryId: expect.anything() }));
    });

    // Issue #87 review follow-up (second round, Important finding 1): a
    // prerequisite check failure (none of which ever touch the remote) must
    // NOT overwrite a PRIOR run's recorded target — the working directory
    // still holds whatever that prior run actually distributed. Mirrors
    // ExecuteTaskUseCase.execute()'s matching test.
    it('does NOT overwrite a previously recorded distributionRepositoryId when a prerequisite check fails (no working directory configured)', async () => {
      const fetchDistributionService = mockFetchDistributionService();
      withRepository(deps.projectRepo);
      deps = makeDeps({
        ...deps,
        fetchDistributionService,
        transportFactory: agentTransportFactory(),
        serverRepo: {
          ...deps.serverRepo,
          findByName: vi.fn(() => ({ name: 'test-server', type: 'agent' as const, host: 'host-a', agentPort: 4021, agentToken: null, agentVersion: null, sshHost: null, sshHostFingerprint: null, muxRuntime: 'system' as const, isolationIntent: true, isolationVerifiedAt: null, isolationReport: null, isolationCleanupReport: null, createdAt: '2026-01-01' })),
        },
        projectServerRepo: {
          ...deps.projectServerRepo,
          find: vi.fn(() => ({ projectId: 10, serverName: 'test-server', workingDirectory: null, branch: null, tmuxSession: 'azito', inputPolicy: 'manual-approval' as const, distributeCode: false, distributionRepositoryId: 1 })),
        },
      });
      service = new TaskRestoreService(deps);
      // Task previously distributed from repo 1 (a PRIOR run's recorded
      // value) — this restore has no working directory configured anywhere,
      // so `performDistribution` must fail on its `no_working_dir` stage
      // before ever reaching `onBeforeDistribute`.
      const task = makeTask({ serverName: 'test-server', workingDirectory: null, distributionRepositoryId: 1 });

      await expect(service.restore(task, log)).rejects.toThrow(/Fetch distribution failed/);

      expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
      expect(deps.taskRepo.update).not.toHaveBeenCalledWith(task.id, expect.objectContaining({ distributionRepositoryId: expect.anything() }));
    });

    // Same prerequisite-failure-preserves-record guarantee, this time via
    // the `no_token` stage (repository resolved but has no token
    // configured) — a different prerequisite check, same rule.
    it('does NOT overwrite a previously recorded distributionRepositoryId when a prerequisite check fails (no token configured)', async () => {
      const fetchDistributionService = mockFetchDistributionService();
      withRepository(deps.projectRepo);
      (deps.projectRepo.findRepositoryById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 1, name: 'repo', url: 'https://github.com/acme/repo.git', provider: 'github' as const, owner: 'acme', repoName: 'repo', token: null,
      });
      deps = makeDeps({
        ...deps,
        fetchDistributionService,
        transportFactory: agentTransportFactory(),
        serverRepo: {
          ...deps.serverRepo,
          findByName: vi.fn(() => ({ name: 'test-server', type: 'agent' as const, host: 'host-a', agentPort: 4021, agentToken: null, agentVersion: null, sshHost: null, sshHostFingerprint: null, muxRuntime: 'system' as const, isolationIntent: true, isolationVerifiedAt: null, isolationReport: null, isolationCleanupReport: null, createdAt: '2026-01-01' })),
        },
      });
      service = new TaskRestoreService(deps);
      const task = makeTask({ serverName: 'test-server', distributionRepositoryId: 1 });

      await expect(service.restore(task, log)).rejects.toThrow(/Fetch distribution failed/);

      expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
      expect(deps.taskRepo.update).not.toHaveBeenCalledWith(task.id, expect.objectContaining({ distributionRepositoryId: expect.anything() }));
    });

    // Issue #87 14th-round review, Important finding 1: performDistribution()
    // (and its own `no_working_dir` fail-fast) used to run inside
    // `if (workingDir)` — so an isolated server / distribute_code task
    // restored with NO working directory configured anywhere (task.workingDirectory
    // AND the project server's workingDirectory both null) bypassed the
    // check entirely and opened the task window on unverified content. It
    // must fail the same way ExecuteTaskUseCase's unconditional call does.
    it('fails fast (no window left open) restoring an isolated-server task with no workingDir configured anywhere', async () => {
      const fetchDistributionService = mockFetchDistributionService();
      withRepository(deps.projectRepo);
      deps = makeDeps({
        ...deps,
        fetchDistributionService,
        transportFactory: agentTransportFactory(),
        serverRepo: {
          ...deps.serverRepo,
          findByName: vi.fn(() => ({ name: 'test-server', type: 'agent' as const, host: 'host-a', agentPort: 4021, agentToken: null, agentVersion: null, sshHost: null, sshHostFingerprint: null, muxRuntime: 'system' as const, isolationIntent: true, isolationVerifiedAt: null, isolationReport: null, isolationCleanupReport: null, createdAt: '2026-01-01' })),
        },
        projectServerRepo: {
          ...deps.projectServerRepo,
          find: vi.fn(() => ({ projectId: 10, serverName: 'test-server', workingDirectory: null, branch: null, tmuxSession: 'azito', inputPolicy: 'manual-approval' as const, distributeCode: false, distributionRepositoryId: null })),
        },
      });
      service = new TaskRestoreService(deps);
      const task = makeTask({ serverName: 'test-server', workingDirectory: null });

      await expect(service.restore(task, log)).rejects.toThrow(/Fetch distribution failed/);

      // performDistribution's own no_working_dir stage must have been the
      // reason — distribute() itself was never even reached.
      expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
      // No worktree, and the window this run created is rolled back — the
      // task must not be left with an open window running on unverified
      // content.
      expect(deps.worktreeServiceFactory.create).not.toHaveBeenCalled();
      expect(deps.tmux.killWindow).toHaveBeenCalled();
    });

    // Counterpart to the above: when a working directory IS configured
    // (task.workingDirectory or the project server's), restore continues to
    // distribute and succeed exactly as before this fix.
    it('still distributes and restores successfully on an isolated server when workingDir IS configured', async () => {
      const fetchDistributionService = mockFetchDistributionService();
      withRepository(deps.projectRepo);
      deps = makeDeps({
        ...deps,
        fetchDistributionService,
        transportFactory: agentTransportFactory(),
        serverRepo: {
          ...deps.serverRepo,
          findByName: vi.fn(() => ({ name: 'test-server', type: 'agent' as const, host: 'host-a', agentPort: 4021, agentToken: null, agentVersion: null, sshHost: null, sshHostFingerprint: null, muxRuntime: 'system' as const, isolationIntent: true, isolationVerifiedAt: null, isolationReport: null, isolationCleanupReport: null, createdAt: '2026-01-01' })),
        },
      });
      service = new TaskRestoreService(deps);
      const task = makeTask({ serverName: 'test-server' });

      const result = await service.restore(task, log);

      expect(fetchDistributionService.distribute).toHaveBeenCalled();
      expect(result.worktreePath).toBe(worktreeDir);
    });

    it('does NOT run fetch distribution for a plain local, non-distribute_code server', async () => {
      const fetchDistributionService = mockFetchDistributionService();
      deps = makeDeps({ ...deps, fetchDistributionService });
      service = new TaskRestoreService(deps);
      const task = makeTask({ serverName: 'test-server' });

      const result = await service.restore(task, log);

      expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
      expect(result.worktreePath).toBe(worktreeDir);
    });

    // Issue #87 review (forge/87-mirror follow-up), Important finding 3: a
    // restore whose OWN run does not require distribution must not
    // unconditionally clear a PRIOR run's recorded distributionRepositoryId
    // — the checkout that recorded id came from can still be sitting on
    // disk (e.g. distribute_code was toggled off on the SAME server after a
    // prior run already distributed). Only clear when there is positive
    // evidence (a distribution_state row) that the CURRENT server does NOT
    // hold that repository's content.
    describe('distributionRepositoryId retention when this run does not require distribution', () => {
      it('keeps a previously recorded distributionRepositoryId when distribution_state proves this SAME server already holds that repository (distribute_code toggled off after a prior distribution)', async () => {
        const fetchDistributionService = mockFetchDistributionService();
        const distributionStateRepo = {
          upsert: vi.fn(),
          deleteByServer: vi.fn(),
          find: vi.fn((serverName: string, repositoryId: number) =>
            serverName === 'test-server' && repositoryId === 5
              ? { lastDistributedSha: 'a'.repeat(40), bundleType: 'full' as const, distributedAt: '2026-01-01T00:00:00Z' }
              : null),
          findManyByRepositoryIds: vi.fn(() => []),
        };
        deps = makeDeps({ ...deps, fetchDistributionService, distributionStateRepo });
        service = new TaskRestoreService(deps);
        const task = makeTask({ serverName: 'test-server', distributionRepositoryId: 5 });

        await service.restore(task, log);

        expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
        expect(distributionStateRepo.find).toHaveBeenCalledWith('test-server', 5);
        expect(deps.taskRepo.update).not.toHaveBeenCalledWith(task.id, expect.objectContaining({ distributionRepositoryId: null }));
      });

      it('clears a previously recorded distributionRepositoryId when distribution_state shows this server does NOT hold that repository (e.g. the task moved to a different server)', async () => {
        const fetchDistributionService = mockFetchDistributionService();
        const distributionStateRepo = {
          upsert: vi.fn(),
          deleteByServer: vi.fn(),
          find: vi.fn(() => null),
          findManyByRepositoryIds: vi.fn(() => []),
        };
        deps = makeDeps({ ...deps, fetchDistributionService, distributionStateRepo });
        service = new TaskRestoreService(deps);
        const task = makeTask({ serverName: 'test-server', distributionRepositoryId: 5 });

        await service.restore(task, log);

        expect(distributionStateRepo.find).toHaveBeenCalledWith('test-server', 5);
        expect(deps.taskRepo.update).toHaveBeenCalledWith(task.id, expect.objectContaining({ distributionRepositoryId: null }));
      });

      it('keeps (never clears) a previously recorded distributionRepositoryId when distributionStateRepo is not wired — insufficient information fails toward keeping the record', async () => {
        const fetchDistributionService = mockFetchDistributionService();
        deps = makeDeps({ ...deps, fetchDistributionService, distributionStateRepo: null });
        service = new TaskRestoreService(deps);
        const task = makeTask({ serverName: 'test-server', distributionRepositoryId: 5 });

        await service.restore(task, log);

        expect(deps.taskRepo.update).not.toHaveBeenCalledWith(task.id, expect.objectContaining({ distributionRepositoryId: null }));
      });
    });

    // Issue #87 16th-round review, Important finding 2: the pre-lock
    // projectServer (resolved before runExclusiveForTask/the isolation lock
    // is even acquired) must never be what decides whether distribution
    // runs — only the row the in-lock gate reverification just re-resolved
    // and validated against may decide that, exactly like the gate decision
    // itself.
    describe('uses the in-lock (not pre-lock) projectServer snapshot to decide distribution (Issue #87 16th-round review, Important finding 2)', () => {
      // `find` is called 3 times over one restore() run: (1) resolveTmuxSession
      // at the very top, (2) resolveExecutionManifest's pre-lock gate check,
      // (3) resolveExecutionManifest inside createRotatedWindow's in-lock
      // preCheck. `distributeCodeFromCall3` flips ONLY from the 3rd call
      // onward, so calls 1-2 always see the OTHER value — modeling a
      // `distribute_code` toggle landing in the window between the pre-lock
      // gate check and the in-lock reverification.
      function projectServerRepoWithToggle(distributeCodeFromCall3: boolean): TaskRestoreDeps['projectServerRepo'] {
        let calls = 0;
        return {
          ...deps.projectServerRepo,
          find: vi.fn(() => {
            calls += 1;
            const distributeCode = calls >= 3 ? distributeCodeFromCall3 : !distributeCodeFromCall3;
            return { projectId: 10, serverName: 'test-server', workingDirectory: rootDir, branch: 'main', tmuxSession: 'azito', inputPolicy: 'manual-approval' as const, distributeCode, distributionRepositoryId: 1 };
          }),
        };
      }

      it('distributes when the pre-lock row said false but the in-lock row says true', async () => {
        const fetchDistributionService = mockFetchDistributionService();
        withRepository(deps.projectRepo);
        deps = makeDeps({
          ...deps,
          fetchDistributionService,
          transportFactory: agentTransportFactory(),
          serverRepo: {
            ...deps.serverRepo,
            findByName: vi.fn(() => ({ name: 'test-server', type: 'agent' as const, host: 'host-a', agentPort: 4021, agentToken: null, agentVersion: null, sshHost: null, sshHostFingerprint: null, muxRuntime: 'system' as const, isolationIntent: false, isolationVerifiedAt: null, isolationReport: null, isolationCleanupReport: null, createdAt: '2026-01-01' })),
          },
          projectServerRepo: projectServerRepoWithToggle(true),
        });
        service = new TaskRestoreService(deps);
        const task = makeTask({ serverName: 'test-server' });

        const result = await service.restore(task, log);

        expect(fetchDistributionService.distribute).toHaveBeenCalled();
        expect(result.worktreePath).toBe(worktreeDir);
      });

      it('does NOT distribute when the pre-lock row said true but the in-lock row says false', async () => {
        const fetchDistributionService = mockFetchDistributionService();
        withRepository(deps.projectRepo);
        deps = makeDeps({
          ...deps,
          fetchDistributionService,
          transportFactory: agentTransportFactory(),
          serverRepo: {
            ...deps.serverRepo,
            findByName: vi.fn(() => ({ name: 'test-server', type: 'agent' as const, host: 'host-a', agentPort: 4021, agentToken: null, agentVersion: null, sshHost: null, sshHostFingerprint: null, muxRuntime: 'system' as const, isolationIntent: false, isolationVerifiedAt: null, isolationReport: null, isolationCleanupReport: null, createdAt: '2026-01-01' })),
          },
          projectServerRepo: projectServerRepoWithToggle(false),
        });
        service = new TaskRestoreService(deps);
        const task = makeTask({ serverName: 'test-server' });

        const result = await service.restore(task, log);

        expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
        expect(result.worktreePath).toBe(worktreeDir);
      });
    });
  });

  // Issue #87 16th-round review, Important finding 1: the stale-old-branch
  // guard inside performDistribution() must see the SAME branch worktree
  // creation is about to (force-)restore into — `task.branch` alone
  // under-covers a task whose `worktreeBranch` (not `task.branch`) names the
  // branch actually being restored, letting a stale local ref slip past the
  // guard and into `git worktree add --force`.
  describe('stale-local-branch guard covers task.worktreeBranch, not just task.branch (Issue #87 16th-round review, Important finding 1)', () => {
    it('fails fast — does not force-restore from a stale local ref — when task.branch is unset but task.worktreeBranch names the branch fetch distribution could not sync', async () => {
      const fetchDistributionService = {
        distribute: vi.fn(async () => ({ status: 'distributed' as const, sha: 'a'.repeat(40), bundleType: 'full' as const, localBranchSynced: false })),
      } as unknown as NonNullable<TaskRestoreDeps['fetchDistributionService']>;
      (deps.projectRepo.findById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 10, name: 'Project', slug: 'project', description: null, repositoryUrl: null, defaultBranch: 'main',
        sidekickPrompt: null, icon: null, color: null, defaultUnitId: 20,
        repositories: [{ id: 1, name: 'repo', url: 'https://github.com/acme/repo.git', provider: 'github' as const, owner: 'acme', repoName: 'repo', hasToken: true }],
        windows: [], createdAt: '2026-01-01', updatedAt: '2026-01-01',
      });
      (deps.projectRepo.findRepositoryById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: 1, name: 'repo', url: 'https://github.com/acme/repo.git', provider: 'github' as const, owner: 'acme', repoName: 'repo', token: 'dummy-token',
      });
      deps = makeDeps({
        ...deps,
        fetchDistributionService,
        serverRepo: {
          ...deps.serverRepo,
          findByName: vi.fn(() => ({ name: 'test-server', type: 'agent' as const, host: 'host-a', agentPort: 4021, agentToken: null, agentVersion: null, sshHost: null, sshHostFingerprint: null, muxRuntime: 'system' as const, isolationIntent: true, isolationVerifiedAt: null, isolationReport: null, isolationCleanupReport: null, createdAt: '2026-01-01' })),
        },
        transportFactory: {
          getTransport: vi.fn(() => ({
            exec: vi.fn(async (cmd: string) => {
              const match = /^cd -- (.+) && pwd -P$/.exec(cmd);
              const rawPath = match ? match[1] : worktreeDir;
              const unquoted = rawPath.startsWith("'") ? rawPath.slice(1, -1).replace(/'\\''/g, "'") : rawPath;
              return { stdout: `${unquoted}\n`, stderr: '', code: 0 };
            }),
          })),
        } as unknown as TaskRestoreDeps['transportFactory'],
        projectServerRepo: {
          ...deps.projectServerRepo,
          find: vi.fn(() => ({ projectId: 10, serverName: 'test-server', workingDirectory: rootDir, branch: 'main', tmuxSession: 'azito', inputPolicy: 'manual-approval' as const, distributeCode: false, distributionRepositoryId: 1 })),
        },
      });
      service = new TaskRestoreService(deps);
      // task.branch unset (null) — task.worktreeBranch is the ONLY thing
      // naming 'main', the same branch baseBranch resolves to (both from
      // task.baseBranch here) — so performDistribution's guard compares
      // worktreeBranch against baseBranch, not an empty task.branch.
      const task = makeTask({ serverName: 'test-server', branch: null, worktreeBranch: 'main', baseBranch: 'main' });

      await expect(service.restore(task, log)).rejects.toThrow(/could not be updated to the distributed content/);

      // The guard must have fired BEFORE worktree creation — never allowed
      // to fall through to `git worktree add --force` against the stale ref.
      expect(deps.worktreeServiceFactory.create).not.toHaveBeenCalled();
      expect(deps.tmux.killWindow).toHaveBeenCalled();
    });
  });

  describe('execution gate (Issue #328)', () => {
    it('blocks an untrusted, unapproved task before touching tmux — status becomes pending_approval, pendingOperation records "restore"', async () => {
      // Third-round review finding 1 (Issue #328): before pendingOperation
      // existed, the approval handler inferred "which operation to resume"
      // from task.tmuxWindow — but an archived task never has a tmuxWindow
      // either, so approving this exact block used to run execute() instead
      // of restore(), skipping worktree/window reconstruction.
      const task = makeTask({ serverName: 'test-server', inputTrust: 'untrusted', executionApprovedFingerprintHash: null });

      await expect(service.restore(task, log)).rejects.toThrow(/requires approval/);

      expect(deps.tmux.createWindow).not.toHaveBeenCalled();
      expect(deps.worktreeServiceFactory.create).not.toHaveBeenCalled();
      expect(deps.taskRepo.recordExecutionGateBlock).toHaveBeenCalledWith(1, {
        pendingOperation: 'restore',
        priorStatus: 'archived',
        manifestHash: expect.any(String),
      });
    });

    it("emits a 'log' event with the status_change entry on the shared events EventEmitter — this, not logRepo.append() alone, is what reaches buildServer.ts's NotificationBus/push bridges (Issue #328 fifteenth-round review)", async () => {
      // Regression: TaskRestoreService used to call logRepo.append() directly
      // with no corresponding events.emit(), so a human blocked here never
      // got a live notification or WS task:status update — only a DB row no
      // running code ever reads for that purpose.
      const task = makeTask({ serverName: 'test-server', inputTrust: 'untrusted', executionApprovedFingerprintHash: null });
      const received: Array<{ taskId: number; unitId: number; type: string; content: unknown }> = [];
      deps.events.on('log', (entry) => received.push(entry as typeof received[number]));

      await expect(service.restore(task, log)).rejects.toThrow(/requires approval/);

      const statusChangeEvents = received.filter((e) => e.type === 'status_change');
      expect(statusChangeEvents).toHaveLength(1);
      expect(statusChangeEvents[0]).toMatchObject({
        taskId: 1,
        unitId: 20,
        content: { status: 'pending_approval', operation: 'restore' },
      });
      // The 'command' entry (execution_gate_blocked) must ALSO be emitted,
      // not just persisted — same appendLogAndEmit() call site pairing.
      expect(received.some((e) => e.type === 'command')).toBe(true);
    });

    it('allows an untrusted task whose approval hash matches the current fingerprint (config unchanged since approval)', async () => {
      const { resolveExecutionManifest, hashExecutionManifest } = await import('./execution/ExecutionManifest.js');
      const task = makeTask({
        serverName: 'test-server',
        inputTrust: 'untrusted',
        description: 'do the thing',
      });
      // 'redistribute', not 'continuation' (Issue #87 review, forge/87-mirror
      // follow-up round 2, Important finding): this is the SAME kind
      // restore() itself now resolves its gate manifest with — see
      // TaskRestoreService.restore()'s own resolveExecutionManifest() call.
      const { manifest } = resolveExecutionManifest(task, deps, 'redistribute');
      task.executionApprovedFingerprintHash = hashExecutionManifest(manifest);

      const result = await service.restore(task, log);

      expect(result.tmuxTarget).toBe('azito:task-1.1');
      expect(deps.tmux.createWindow).toHaveBeenCalled();
    });

    // Issue #87 review (forge/87-mirror follow-up round 2), Important
    // finding: restore()'s gate used to resolve its manifest as
    // 'continuation' (task.distributionRepositoryId — repository A,
    // recorded from a past run), while performDistribution() actually pulls
    // from the CURRENT projectServer.distributionRepositoryId (repository
    // B once the project server is re-pointed). An approval given while the
    // fingerprint hashed A stayed valid forever, even after the project
    // server moved to B — the gate never re-hashed the value
    // performDistribution() was about to act on, so a restore approved for
    // A silently authorized distributing B. Fixed by resolving restore()'s
    // gate manifest with 'redistribute' (current config), which agrees with
    // performDistribution().
    it('invalidates a restore approval given for repository A once the project server is re-pointed to repository B — performDistribution() must never run under a stale A-approval', async () => {
      const { resolveExecutionManifest, hashExecutionManifest } = await import('./execution/ExecutionManifest.js');
      const fetchDistributionService = {
        distribute: vi.fn(async () => ({ status: 'distributed', sha: 'a'.repeat(40), bundleType: 'full', localBranchSynced: true })),
      } as unknown as NonNullable<TaskRestoreDeps['fetchDistributionService']>;
      const repoA = { id: 1, name: 'repo-a', url: 'https://github.com/acme/repo-a.git', provider: 'github' as const, owner: 'acme', repoName: 'repo-a', hasToken: true };
      const repoB = { id: 2, name: 'repo-b', url: 'https://github.com/acme/repo-b.git', provider: 'github' as const, owner: 'acme', repoName: 'repo-b', hasToken: true };
      const projectWithRepos = {
        id: 10, name: 'Project', slug: 'project', description: null, repositoryUrl: null, defaultBranch: 'main',
        sidekickPrompt: null, icon: null, color: null, defaultUnitId: 20,
        repositories: [repoA, repoB], windows: [], createdAt: '2026-01-01', updatedAt: '2026-01-01',
      };
      // Distribution required (isolated agent server) so `repository` (not
      // just the scalar distributionRepositoryId) also differs between A
      // and B — the full identity a human actually reviews on the approval
      // screen.
      const isolatedServer = { name: 'test-server', type: 'agent' as const, host: 'host-a', agentPort: 4021, agentToken: null, agentVersion: null, sshHost: null, sshHostFingerprint: null, muxRuntime: 'system' as const, isolationIntent: true, isolationVerifiedAt: null, isolationReport: null, isolationCleanupReport: null, createdAt: '2026-01-01' };
      const projectServerAtA = { projectId: 10, serverName: 'test-server', workingDirectory: worktreeDir, branch: 'main', tmuxSession: 'azito', inputPolicy: 'manual-approval' as const, distributeCode: true, distributionRepositoryId: 1 };
      const projectServerAtB = { ...projectServerAtA, distributionRepositoryId: 2 };

      deps = makeDeps({
        ...deps,
        fetchDistributionService,
        transportFactory: {
          getTransport: vi.fn(() => ({
            exec: vi.fn(async (cmd: string) => {
              const match = /^cd -- (.+) && pwd -P$/.exec(cmd);
              const rawPath = match ? match[1] : worktreeDir;
              const unquoted = rawPath.startsWith("'") ? rawPath.slice(1, -1).replace(/'\\''/g, "'") : rawPath;
              return { stdout: `${unquoted}\n`, stderr: '', code: 0 };
            }),
          })),
        } as unknown as TaskRestoreDeps['transportFactory'],
        serverRepo: { ...deps.serverRepo, findByName: vi.fn(() => isolatedServer) },
        projectRepo: {
          ...deps.projectRepo,
          findById: vi.fn(() => projectWithRepos),
          findRepositoryById: vi.fn((id: number) => (id === 1 ? { ...repoA, token: 'token-a' } : { ...repoB, token: 'token-b' })),
        },
        // Approval time: project server still points at repository A.
        projectServerRepo: { ...deps.projectServerRepo, find: vi.fn(() => projectServerAtA), findByProject: vi.fn(() => [projectServerAtA]) },
      });
      service = new TaskRestoreService(deps);

      // A task that already distributed from repository A on a past run
      // (recorded), and was approved for restore while the project server
      // still named A too.
      const task = makeTask({ serverName: 'test-server', inputTrust: 'untrusted', description: 'do the thing', distributionRepositoryId: 1 });
      const { manifest: manifestAtA } = resolveExecutionManifest(task, deps, 'redistribute');
      task.executionApprovedFingerprintHash = hashExecutionManifest(manifestAtA);

      // The operator re-points the project server at repository B AFTER
      // approval — task.distributionRepositoryId (the recorded PAST value)
      // is untouched.
      deps.projectServerRepo.find = vi.fn(() => projectServerAtB);
      deps.projectServerRepo.findByProject = vi.fn(() => [projectServerAtB]);

      await expect(service.restore(task, log)).rejects.toThrow(/requires approval/);

      // The gate blocked BEFORE performDistribution() ran — fetch
      // distribution (which would have pulled repository B under an
      // approval only ever given for A) was never invoked, and no
      // window/worktree was created either.
      expect(fetchDistributionService.distribute).not.toHaveBeenCalled();
      expect(deps.tmux.createWindow).not.toHaveBeenCalled();
      expect(deps.worktreeServiceFactory.create).not.toHaveBeenCalled();
      expect(deps.taskRepo.recordExecutionGateBlock).toHaveBeenCalledWith(task.id, {
        pendingOperation: 'restore',
        priorStatus: 'archived',
        manifestHash: expect.any(String),
      });
    });

    it('denies an untrusted task outright under a "deny" project server policy, without changing status', async () => {
      const task = makeTask({ serverName: 'test-server', inputTrust: 'untrusted' });
      deps = makeDeps({
        ...deps,
        projectServerRepo: {
          ...deps.projectServerRepo,
          find: vi.fn(() => ({ projectId: 10, serverName: 'test-server', workingDirectory: rootDir, branch: 'main', tmuxSession: 'azito', inputPolicy: 'deny' as const, distributeCode: false, distributionRepositoryId: null })),
        },
      });
      service = new TaskRestoreService(deps);

      await expect(service.restore(task, log)).rejects.toThrow(/denied/);

      expect(deps.tmux.createWindow).not.toHaveBeenCalled();
      expect(deps.taskRepo.updateStatus).not.toHaveBeenCalled();
    });

    it('does not gate a trusted task even with no project_servers row', async () => {
      const task = makeTask({ serverName: 'test-server', inputTrust: 'trusted' });
      deps = makeDeps({
        ...deps,
        projectServerRepo: {
          ...deps.projectServerRepo,
          find: vi.fn(() => null),
        },
      });
      service = new TaskRestoreService(deps);

      const result = await service.restore(task, log);

      expect(result.tmuxTarget).toBe('azito:task-1.1');
    });
  });
});
