import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import tasksRoutes from './routes';
import type { TasksRouteOptions } from './routes';
import type { Task } from './Task';

// GET /api/tasks/:id/execution-approval (Issue #51) — the browser-facing
// read API for what the untrusted-input execution gate blocked and what a
// human needs to see before approving/denying it. Covers: 404 when the task
// isn't currently pending_approval (nothing live to approve), the 200 shape
// when it is, that secret VALUES never appear (names only), and that the
// resolved execution context (unit/server/branches/phases) comes through.

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    projectId: 10,
    unitId: 20,
    serverName: 'test-server',
    title: 'Imported issue task',
    description: 'Attacker-controlled body from GitHub issue #42',
    status: 'pending_approval',
    currentPhase: null,
    selfReviewCount: 0,
    priority: 0,
    tmuxWindow: null,
    selfReviewMaxAttempts: null,
    requirePlanApproval: true,
    source: 'github',
    sourceRef: 'owner/repo#42',
    worktreePath: null,
    worktreeBranch: null,
    baseBranch: 'main',
    targetBranch: null,
    skipPr: false,
    workingDirectory: null,
    branch: 'task-1-branch',
    planMarkdown: null,
    pendingQuestions: null,
    changedFiles: null,
    summaryJson: null,
    prUrl: null,
    agentSessionId: null,
    inputTrust: 'untrusted',
    executionApprovedFingerprintHash: null,
    pendingOperation: 'execute',
    pendingOperationWindowId: null,
    pendingOperationPriorStatus: 'open',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeOpts(existingTask: Task | null): TasksRouteOptions {
  return {
    taskRepo: {
      findAll: vi.fn(() => []),
      findByProject: vi.fn(() => []),
      findByUnit: vi.fn(() => []),
      findByStatus: vi.fn(() => []),
      findAgentSessionIdsByServer: vi.fn(() => new Set<string>()),
      findById: vi.fn((id: number) => (existingTask && id === existingTask.id ? existingTask : null)),
      create: vi.fn(() => 2),
      update: vi.fn(),
      updateStatus: vi.fn(),
      updateCurrentPhase: vi.fn(),
      touch: vi.fn(),
      delete: vi.fn(),
      consumePendingApproval: vi.fn(() => false),
    },
    projectRepo: {
      findAll: vi.fn(() => []),
      findById: vi.fn(() => ({ id: 10, name: 'P', slug: 'p', description: null, repositoryUrl: null, defaultBranch: 'main', sidekickPrompt: null, icon: null, color: null, defaultUnitId: 20, servers: [], repositories: [{ id: 1, provider: 'github' as const, url: 'https://github.com/o/r', owner: 'o', repoName: 'r', name: 'o/r', hasToken: false }], windows: [], createdAt: '', updatedAt: '' })),
      create: vi.fn(() => 10),
      update: vi.fn(),
      delete: vi.fn(),
      addRepository: vi.fn(() => 1),
      findRepositoryById: vi.fn(() => null),
      removeRepository: vi.fn(),
    },
    projectServerRepo: {
      findByProject: vi.fn(() => [{ projectId: 10, serverName: 'test-server', workingDirectory: '/work', branch: 'main', tmuxSession: 'azito', inputPolicy: 'manual-approval' as const }]),
      findByServer: vi.fn(() => []),
      find: vi.fn(() => ({ projectId: 10, serverName: 'test-server', workingDirectory: '/work', branch: 'main', tmuxSession: 'azito', inputPolicy: 'manual-approval' as const })),
      upsert: vi.fn(),
      remove: vi.fn(),
    },
    logRepo: {
      findByTask: vi.fn(() => []),
      findByUnit: vi.fn(() => []),
      append: vi.fn(),
    },
    executeTaskUseCase: {
      stopByTaskId: vi.fn(() => false),
      execute: vi.fn(),
      followUp: vi.fn(),
      events: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
    } as unknown as TasksRouteOptions['executeTaskUseCase'],
    unitRepo: {
      findAll: vi.fn(() => []),
      findById: vi.fn(() => ({ id: 20, name: 'Devops Unit', unitType: 'devops', systemPrompt: null, selfReviewMaxAttempts: 2, reviewSubagent: null, implementSubagent: null, phaseConfig: null, workerType: 'claude', workerModel: 'opus', workerExtraArgs: null, workerExecutionMode: 'tmux-pipe' as const, workerRuntime: 'tui' as const, createdAt: '', updatedAt: '' })),
      create: vi.fn(() => 20),
      update: vi.fn(),
      delete: vi.fn(),
    },
    tmux: {
      listSessions: vi.fn(async () => []),
      createSession: vi.fn(async () => ({ result: { stdout: '', stderr: '', code: 0 }, windowName: 'w' })),
      createWindow: vi.fn(async () => ({ result: { stdout: '', stderr: '', code: 0 }, windowName: 'task-1' })),
      killWindow: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
      sendKeys: vi.fn(async () => {}),
      checkPaneExists: vi.fn(async () => true),
      killPane: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
    } as unknown as TasksRouteOptions['tmux'],
    serverRepo: {
      findAll: vi.fn(() => []),
      findByName: vi.fn(() => ({ name: 'test-server', type: 'local' as const, host: '', agentPort: null, agentToken: null, agentVersion: null, sshHost: null, sshHostFingerprint: null, muxRuntime: 'system' as const, createdAt: '' })),
      create: vi.fn(),
      update: vi.fn(),
      updateAgentVersion: vi.fn(),
      updateFingerprint: vi.fn(),
      clearFingerprint: vi.fn(),
      delete: vi.fn(),
    },
    worktreeServiceFactory: { create: vi.fn() } as unknown as TasksRouteOptions['worktreeServiceFactory'],
    transportFactory: { getTransport: vi.fn(() => ({})) } as unknown as TasksRouteOptions['transportFactory'],
    windowRepo: {
      findByTaskIds: vi.fn(() => new Map()),
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
    respawnService: {
      respawn: vi.fn(async () => ({ tmuxTarget: 'azito:task-1.1' })),
      resumeLegacySession: vi.fn(async () => ({ windowName: 'task-1' })),
    } as unknown as TasksRouteOptions['respawnService'],
    taskRestoreService: { restore: vi.fn(async () => ({ tmuxTarget: 'azito:task-1.1', worktreePath: null })) } as unknown as TasksRouteOptions['taskRestoreService'],
    unitTypeLoader: {
      getOrThrow: vi.fn(() => ({ name: 'devops', label: 'DevOps', description: '', phases: [] })),
      get: vi.fn(() => ({
        name: 'devops',
        label: 'DevOps',
        description: '',
        phases: [
          { name: 'implementing', label: 'Implementing', tags: ['implementing'], planApproval: false, questions: true, testFailed: false, selfReviewRetry: false, pushVerify: false },
        ],
      })),
    } as unknown as TasksRouteOptions['unitTypeLoader'],
    sidekickLoader: {
      findDefaultForTag: vi.fn(() => ({ name: 'implementing-default', dir: '/tmp/does-not-exist', body: 'do the thing', tags: ['implementing'] })),
      findByName: vi.fn(() => undefined),
    } as unknown as TasksRouteOptions['sidekickLoader'],
    projectSecretRepo: {
      findByProject: vi.fn(() => [
        { id: 2, projectId: 10, name: 'GH_TOKEN', createdAt: '' },
        { id: 1, projectId: 10, name: 'API_KEY', createdAt: '' },
      ]),
    } as unknown as TasksRouteOptions['projectSecretRepo'],
  };
}

describe('GET /api/tasks/:id/execution-approval (Issue #51)', () => {
  it('404s when the task does not exist', async () => {
    const app = Fastify();
    await app.register(tasksRoutes, makeOpts(null));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/tasks/999/execution-approval' });
    expect(res.statusCode).toBe(404);
  });

  it('404s when the task exists but is not pending_approval', async () => {
    const app = Fastify();
    await app.register(tasksRoutes, makeOpts(makeTask({ status: 'open' })));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/tasks/1/execution-approval' });
    expect(res.statusCode).toBe(404);
  });

  it('returns the resolved execution context and secret NAMES (never values) for a pending_approval task', async () => {
    const app = Fastify();
    await app.register(tasksRoutes, makeOpts(makeTask()));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/api/tasks/1/execution-approval' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body).toMatchObject({
      taskId: 1,
      title: 'Imported issue task',
      description: 'Attacker-controlled body from GitHub issue #42',
      inputTrust: 'untrusted',
      pendingOperation: 'execute',
      inputPolicy: 'manual-approval',
    });
    expect(body.execution.unitId).toBe(20);
    expect(body.execution.unitName).toBe('Devops Unit');
    expect(body.execution.serverName).toBe('test-server');
    expect(body.execution.workingDirectory).toBe('/work');
    expect(body.execution.branches).toMatchObject({ base: 'main', work: 'task-1-branch' });
    expect(body.execution.phases).toEqual([{ phase: 'implementing', sidekickName: 'implementing-default' }]);
    expect(body.execution.repository).toMatchObject({ provider: 'github', owner: 'o', repoName: 'r' });

    // Names only, sorted — never plaintext values, and never the digest a
    // human can't act on.
    expect(body.secretNames).toEqual(['API_KEY', 'GH_TOKEN']);
    const json = JSON.stringify(body);
    expect(json).not.toContain('namesDigest');
  });
});
