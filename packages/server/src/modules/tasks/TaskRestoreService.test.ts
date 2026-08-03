import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskRestoreService, type TaskRestoreDeps } from './TaskRestoreService';
import type { Task } from './Task';

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
    },
    serverRepo: {
      findAll: vi.fn(() => []),
      findByName: vi.fn(() => ({ name: 'test-server', type: 'local' as const, host: '', agentPort: null, agentToken: null, agentVersion: null, sshHost: null, sshHostFingerprint: null, muxRuntime: 'system' as const, createdAt: '2026-01-01' })),
      create: vi.fn(),
      update: vi.fn(),
      updateAgentVersion: vi.fn(),
      updateFingerprint: vi.fn(),
      clearFingerprint: vi.fn(),
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
      removeRepository: vi.fn(),
    },
    projectServerRepo: {
      findByProject: vi.fn(() => [{ projectId: 10, serverName: 'test-server', workingDirectory: '/work', branch: 'main', tmuxSession: 'azito' }]),
      findByServer: vi.fn(() => []),
      find: vi.fn(() => ({ projectId: 10, serverName: 'test-server', workingDirectory: '/work', branch: 'main', tmuxSession: 'azito' })),
      upsert: vi.fn(),
      remove: vi.fn(),
    },
    unitRepo: {
      findAll: vi.fn(() => []),
      findById: vi.fn(() => ({ id: 20, name: 'Unit', unitType: 'devops', systemPrompt: null, selfReviewMaxAttempts: 0, reviewSubagent: null, implementSubagent: null, workerType: 'claude', workerModel: 'claude-opus-4-5', workerExtraArgs: null, workerExecutionMode: 'tmux-pipe' as const, workerRuntime: 'tui' as const, phaseConfig: null, createdAt: '2026-01-01', updatedAt: '2026-01-01' })),
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
      findAgentSessionIdsByServer: vi.fn(() => new Set<string>()),
      findByServerAndTarget: vi.fn(() => undefined),
      update: vi.fn(),
      updateAgentSessionIdByWindow: vi.fn(),
      remove: vi.fn(),
      removeByServerAndTarget: vi.fn(() => 0),
      updatePaneLayout: vi.fn(),
    },
    tmux: {
      listSessions: vi.fn(async () => [{ name: 'azito', windows: [] }]),
      createSession: vi.fn(async () => ({ result: { stdout: '', stderr: '', code: 0 }, windowName: 'task-1' })),
      createWindow: vi.fn(async () => ({ result: { stdout: '', stderr: '', code: 0 }, windowName: 'task-1' })),
      killWindow: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
      resolvePaneId: vi.fn(async () => '%0'),
      sendKeys: vi.fn(async () => {}),
      checkPaneExists: vi.fn(async () => true),
    } as unknown as TaskRestoreDeps['tmux'],
    worktreeServiceFactory: {
      create: vi.fn(() => ({
        create: vi.fn(async () => ({ path: '/work/.worktrees/task-1', branch: 'feat/test-task' })),
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
    ...overrides,
  };
}

describe('TaskRestoreService', () => {
  let deps: TaskRestoreDeps;
  let service: TaskRestoreService;
  const log = { warn: vi.fn() };

  beforeEach(() => {
    deps = makeDeps();
    service = new TaskRestoreService(deps);
    vi.clearAllMocks();
  });

  it('restores an archived task: creates session, window, worktree, window row, updates status', async () => {
    const task = makeTask({ serverName: 'test-server' });

    const result = await service.restore(task, log);

    expect(result.tmuxTarget).toBe('azito:task-1.1');
    expect(result.worktreePath).toBe('/work/.worktrees/task-1');
    expect(deps.tmux.createWindow).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'test-server' }),
      'azito',
      'task-1',
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
    expect(worktreeService.create).toHaveBeenCalledWith('/work', 1, 'task-1', 'main', 'feat/existing-branch');
  });

  it('falls back to task.worktreeBranch when task.branch is null', async () => {
    const task = makeTask({ serverName: 'test-server', branch: null, worktreeBranch: 'feat/worktree-branch' });

    await service.restore(task, log);

    expect(deps.contentExtractor.generateSlug).not.toHaveBeenCalled();
    const worktreeService = (deps.worktreeServiceFactory.create as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(worktreeService.create).toHaveBeenCalledWith('/work', 1, 'task-1', 'main', 'feat/worktree-branch');
  });

  it('passes a non-empty slug even when branch is specified (assertSafeBranch compatibility)', async () => {
    const task = makeTask({ id: 42, serverName: 'test-server', branch: 'feat/my-branch' });

    await service.restore(task, log);

    const worktreeService = (deps.worktreeServiceFactory.create as ReturnType<typeof vi.fn>).mock.results[0].value;
    const slugArg = worktreeService.create.mock.calls[0][2];
    expect(slugArg).toBe('task-42');
    expect(slugArg.length).toBeGreaterThan(0);
  });

  it('skips worktree creation when no workingDir is available', async () => {
    const task = makeTask({ serverName: 'test-server', workingDirectory: null });
    deps = makeDeps({
      ...deps,
      projectServerRepo: {
        ...deps.projectServerRepo,
        find: vi.fn(() => ({ projectId: 10, serverName: 'test-server', workingDirectory: null, branch: null, tmuxSession: 'azito' })),
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
      {},
    );
  });
});
