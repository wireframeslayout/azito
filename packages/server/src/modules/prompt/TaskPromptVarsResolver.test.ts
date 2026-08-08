import { describe, it, expect, vi } from 'vitest';
import { TaskPromptVarsResolver } from './TaskPromptVarsResolver';
import type { ITaskRepository } from '../tasks/Task';
import type { IProjectRepository } from '../projects/Project';
import type { IUnitRepository } from '../units/Unit';
import type { IProjectServerRepository } from '../projects/ProjectServer';
import type { IServerRepository, ServerConfig } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { SidekickPackageLoader } from '../sidekicks/SidekickPackageLoader';
import type { SidekickSyncService } from '../sidekicks/SidekickSyncService';

const makeTask = (overrides = {}) => ({
  id: 1,
  projectId: 10,
  unitId: 20,
  serverName: 'local',
  title: 'Test Task',
  description: 'A description',
  status: 'open' as const,
  currentPhase: null,
  selfReviewCount: 0,
  priority: 1,
  tmuxWindow: null,
  selfReviewMaxAttempts: null,
  requirePlanApproval: false,
  source: 'local' as const,
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
  inputTrust: 'trusted' as const,
  executionApprovedFingerprintHash: null,
  pendingOperation: null,
  pendingOperationWindowId: null,
  pendingOperationPriorStatus: null,
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
  ...overrides,
});

const makeServer = (overrides: Partial<ServerConfig> = {}): ServerConfig => ({
  name: 'local',
  type: 'local',
  host: null,
  agentPort: null,
  agentToken: null,
  agentVersion: null,
  sshHost: null,
  sshHostFingerprint: null,
  muxRuntime: 'system',
  createdAt: '2024-01-01',
  ...overrides,
});

function makeResolver(overrides: {
  task?: Partial<ITaskRepository>;
  projectServer?: Partial<IProjectServerRepository>;
  serverRepo?: Partial<IServerRepository>;
  transportFactory?: Partial<TransportFactory>;
  sidekickLoader?: Partial<SidekickPackageLoader>;
  sidekickSyncService?: Partial<SidekickSyncService>;
} = {}) {
  const taskRepo = {
    findAll: vi.fn(() => []),
    findByProject: vi.fn(() => []),
    findByUnit: vi.fn(() => []),
    findByStatus: vi.fn(() => []),
    findById: vi.fn(() => makeTask()),
    create: vi.fn(() => 1),
    update: vi.fn(),
    updateStatus: vi.fn(),
    updateCurrentPhase: vi.fn(),
    touch: vi.fn(),
    delete: vi.fn(),
    ...overrides.task,
  } as unknown as ITaskRepository;

  const projectRepo = { findById: vi.fn(() => ({ id: 10, sidekickPrompt: '', defaultBranch: 'main' })) } as unknown as IProjectRepository;
  const unitRepo = { findById: vi.fn(() => null) } as unknown as IUnitRepository;

  const projectServerRepo = {
    findByProject: vi.fn(() => []),
    findByServer: vi.fn(() => []),
    find: vi.fn(() => null),
    upsert: vi.fn(),
    remove: vi.fn(),
    ...overrides.projectServer,
  } as unknown as IProjectServerRepository;

  const serverRepo = {
    findAll: vi.fn(() => []),
    findByName: vi.fn(() => makeServer()),
    create: vi.fn(),
    update: vi.fn(),
    updateAgentVersion: vi.fn(),
    delete: vi.fn(),
    ...overrides.serverRepo,
  } as unknown as IServerRepository;

  const transportFactory = {
    getTransport: vi.fn(() => ({ exec: vi.fn(), execTmux: vi.fn(), openTerminal: vi.fn(), createPaneStream: vi.fn() })),
    invalidate: vi.fn(),
    ...overrides.transportFactory,
  } as unknown as TransportFactory;

  const sidekickLoader = {
    list: vi.fn(() => []),
    findByName: vi.fn(() => null),
    findDefaultForPhase: vi.fn(() => null),
    invalidateCache: vi.fn(),
    ...overrides.sidekickLoader,
  } as unknown as SidekickPackageLoader;

  const sidekickSyncService = {
    sync: vi.fn(async () => {}),
    ...overrides.sidekickSyncService,
  } as unknown as SidekickSyncService;

  const resolver = new TaskPromptVarsResolver(taskRepo, projectRepo, unitRepo, projectServerRepo, serverRepo, transportFactory, sidekickLoader, sidekickSyncService);
  return { resolver, taskRepo, projectServerRepo, serverRepo, transportFactory, sidekickLoader, sidekickSyncService };
}

const pkg = { name: 'pushing-default', dir: '/harness/sidekicks/pushing-default' };

describe('TaskPromptVarsResolver.resolveDir', () => {
  it('returns pkg.dir for a local server without syncing', async () => {
    const { resolver, sidekickSyncService } = makeResolver();

    const dir = await resolver.resolveDir(1, pkg);

    expect(dir).toBe(pkg.dir);
    expect(sidekickSyncService.sync).not.toHaveBeenCalled();
  });

  it('syncs and returns the remote flat path for an ssh server', async () => {
    const { resolver, sidekickSyncService, sidekickLoader } = makeResolver({
      task: { findById: vi.fn(() => makeTask({ serverName: 'staging' })) },
      serverRepo: { findByName: vi.fn(() => makeServer({ name: 'staging', type: 'agent' })) },
      sidekickLoader: { list: vi.fn(() => [pkg as any]) },
    });

    const dir = await resolver.resolveDir(1, pkg);

    expect(sidekickSyncService.sync).toHaveBeenCalledWith('staging', expect.anything(), [pkg]);
    expect(sidekickLoader.list).toHaveBeenCalled();
    expect(dir).toBe(`~/.azito/sidekicks/${pkg.name}`);
  });

  it('falls back to pkg.dir when the task server cannot be resolved (best-effort, no sync)', async () => {
    const { resolver, sidekickSyncService } = makeResolver({
      task: { findById: vi.fn(() => makeTask({ serverName: null })) },
      projectServer: { findByProject: vi.fn(() => []) },
    });

    const dir = await resolver.resolveDir(1, pkg);

    expect(dir).toBe(pkg.dir);
    expect(sidekickSyncService.sync).not.toHaveBeenCalled();
  });

  it('throws when the task cannot be found', async () => {
    const { resolver } = makeResolver({ task: { findById: vi.fn(() => null) } });

    await expect(resolver.resolveDir(999, pkg)).rejects.toThrow('Task not found: 999');
  });

  it('propagates a sync failure (fail fast)', async () => {
    const { resolver } = makeResolver({
      task: { findById: vi.fn(() => makeTask({ serverName: 'staging' })) },
      serverRepo: { findByName: vi.fn(() => makeServer({ name: 'staging', type: 'agent' })) },
      sidekickSyncService: { sync: vi.fn(async () => { throw new Error('boom'); }) },
    });

    await expect(resolver.resolveDir(1, pkg)).rejects.toThrow('boom');
  });
});
