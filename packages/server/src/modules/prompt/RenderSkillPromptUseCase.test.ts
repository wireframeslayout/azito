import { describe, it, expect, vi } from 'vitest';
import { RenderSkillPromptUseCase } from './RenderSkillPromptUseCase';
import type { ITaskRepository } from '../tasks/Task';
import type { IProjectRepository } from '../projects/Project';
import type { IUnitRepository } from '../units/Unit';
import type { IProjectServerRepository } from '../projects/ProjectServer';
import type { IServerRepository, ServerConfig } from '../servers/Server';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { SidekickPackageLoader } from '../sidekicks/SidekickPackageLoader';
import type { SidekickPackage } from '../sidekicks/SidekickPackage';
import type { PhaseConfig } from '../sidekicks/PhaseConfig';
import type { SidekickSyncService } from '../sidekicks/SidekickSyncService';
import type { TaskPhase } from '../sidekicks/TaskPhase';
import type { UnitType, UnitTypePhase } from '../sidekicks/UnitType';
import type { UnitTypeLoader } from '../sidekicks/UnitTypeLoader';

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
  createdByKind: 'operator' as const,
  createdById: null,
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
  ...overrides,
});

const makeProject = (overrides = {}) => ({
  id: 10,
  name: 'TestProject',
  slug: 'test',
  description: null,
  repositoryUrl: null,
  defaultBranch: 'main',
  sidekickPrompt: 'Project prompt',
  icon: null,
  color: null,
  defaultUnitId: null,
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
  repositories: [],
  windows: [],
  ...overrides,
});

const makeUnit = (overrides: { phaseConfig?: PhaseConfig | null } = {}) => ({
  id: 20,
  name: 'TestUnit',
  unitType: 'devops',
  systemPrompt: 'Unit prompt',
  selfReviewMaxAttempts: 2,
  reviewSubagent: null,
  implementSubagent: null,
  phaseConfig: null,
  workerType: null,
  workerModel: null,
  workerExtraArgs: null,
  workerExecutionMode: 'tmux-pipe' as const,
  workerRuntime: 'tui' as const,
  createdAt: '2024-01-01',
  updatedAt: '2024-01-01',
  ...overrides,
});

const makeSidekick = (phase: TaskPhase, body: string, name = `${phase}-default`): SidekickPackage => ({
  name,
  description: `default for ${phase}`,
  tags: [phase],
  isDefault: true,
  layer: 'builtin',
  overridesBuiltin: false,
  dir: `/harness/sidekicks/${name}`,
  body,
  hasScripts: false,
  hasReferences: false,
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

const DEVOPS_PHASES: UnitTypePhase[] = [
  { name: 'planning', label: 'Planning', tags: ['planning'], questions: true, testFailed: false, planApproval: true, selfReviewRetry: false, pushVerify: false, skillCommand: 'azt-plan' },
  { name: 'implementing', label: 'Implementing', tags: ['implementing'], questions: true, testFailed: false, planApproval: false, selfReviewRetry: false, pushVerify: false, subagentRole: 'implement', skillCommand: 'azt-implement' },
  { name: 'reviewing', label: 'Reviewing', tags: ['reviewing'], questions: false, testFailed: false, planApproval: false, selfReviewRetry: true, pushVerify: false, subagentRole: 'review', skillCommand: 'azt-review' },
  { name: 'testing', label: 'Testing', tags: ['testing'], questions: false, testFailed: true, planApproval: false, selfReviewRetry: false, pushVerify: false, testFailedRollbackTo: 'reviewing', skillCommand: 'azt-test' },
  { name: 'pushing', label: 'Pushing', tags: ['pushing'], questions: false, testFailed: false, planApproval: false, selfReviewRetry: false, pushVerify: true, skillCommand: 'azt-push' },
];
const DEVOPS_UNIT_TYPE: UnitType = { name: 'devops', label: 'DevOps', description: 'Standard 5-phase development workflow', phases: DEVOPS_PHASES };

const unitTypeLoader = { getOrThrow: vi.fn().mockReturnValue(DEVOPS_UNIT_TYPE), listNames: vi.fn().mockReturnValue(['devops']) };

function makeRepos(overrides: {
  task?: Partial<ITaskRepository>;
  project?: Partial<IProjectRepository>;
  unit?: Partial<IUnitRepository>;
  projectServer?: Partial<IProjectServerRepository>;
  sidekickLoader?: Partial<SidekickPackageLoader>;
  serverRepo?: Partial<IServerRepository>;
  transportFactory?: Partial<TransportFactory>;
  sidekickSyncService?: Partial<SidekickSyncService>;
} = {}) {
  const taskRepo: ITaskRepository = {
    findAll: vi.fn(() => []),
    findByProject: vi.fn(() => []),
    findByUnit: vi.fn(() => []),
    findByStatus: vi.fn(() => []),
    findAgentSessionIdsByServer: vi.fn(() => new Set<string>()),
    findById: vi.fn(() => makeTask()),
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
    ...overrides.task,
  };

  const projectRepo: IProjectRepository = {
    findAll: vi.fn(() => []),
    findById: vi.fn(() => makeProject()),
    create: vi.fn(() => 10),
    update: vi.fn(),
    delete: vi.fn(),
    addRepository: vi.fn(() => 1),
    findRepositoryById: vi.fn(() => null),
    removeRepository: vi.fn(),
    ...overrides.project,
  };

  const unitRepo: IUnitRepository = {
    findAll: vi.fn(() => []),
    findById: vi.fn(() => makeUnit()),
    create: vi.fn(() => 20),
    update: vi.fn(),
    delete: vi.fn(),
    ...overrides.unit,
  };

  const projectServerRepo: IProjectServerRepository = {
    findByProject: vi.fn(() => []),
    findByServer: vi.fn(() => []),
    find: vi.fn(() => ({ projectId: 10, serverName: 'local', workingDirectory: '/work', branch: 'feat', tmuxSession: 'sess', inputPolicy: 'manual-approval' as const })),
    upsert: vi.fn(),
    remove: vi.fn(),
    ...overrides.projectServer,
  };

  const sidekickLoader: SidekickPackageLoader = {
    list: vi.fn(() => []),
    findByName: vi.fn(() => null),
    findDefaultForTag: vi.fn((phase) => makeSidekick(phase, `Do {{task.title}} work`)),
    invalidateCache: vi.fn(),
    ...overrides.sidekickLoader,
  } as unknown as SidekickPackageLoader;

  const serverRepo: IServerRepository = {
    findAll: vi.fn(() => []),
    findByName: vi.fn(() => makeServer()),
    create: vi.fn(),
    update: vi.fn(),
    updateAgentVersion: vi.fn(),
    updateFingerprint: vi.fn(),
    clearFingerprint: vi.fn(),
    delete: vi.fn(),
    ...overrides.serverRepo,
  };

  const transportFactory = {
    getTransport: vi.fn(() => ({ exec: vi.fn(), execTmux: vi.fn(), openTerminal: vi.fn(), createPaneStream: vi.fn() })),
    invalidate: vi.fn(),
    ...overrides.transportFactory,
  } as unknown as TransportFactory;

  const sidekickSyncService = {
    sync: vi.fn(async () => {}),
    ...overrides.sidekickSyncService,
  } as unknown as SidekickSyncService;

  return { taskRepo, projectRepo, unitRepo, projectServerRepo, sidekickLoader, serverRepo, transportFactory, sidekickSyncService };
}

function makeUseCase(repos: ReturnType<typeof makeRepos>): RenderSkillPromptUseCase {
  return new RenderSkillPromptUseCase(
    repos.taskRepo,
    repos.projectRepo,
    repos.unitRepo,
    repos.projectServerRepo,
    repos.sidekickLoader,
    repos.serverRepo,
    repos.transportFactory,
    repos.sidekickSyncService,
    unitTypeLoader as unknown as UnitTypeLoader,
  );
}

describe('RenderSkillPromptUseCase', () => {
  it('renders skill prompt with expanded variables', async () => {
    const repos = makeRepos();
    const useCase = makeUseCase(repos);

    const result = await useCase.render('planning', 1);

    expect(result.phase).toBe('planning');
    expect(result.prompt).toContain('Test Task');
  });

  it('returns nextPhase when there is a next enabled phase', async () => {
    const repos = makeRepos();
    const useCase = makeUseCase(repos);

    const result = await useCase.render('planning', 1);

    expect(result.nextPhase).toBe('implementing');
  });

  it('returns null nextPhase for the last enabled phase', async () => {
    const repos = makeRepos();
    const useCase = makeUseCase(repos);

    const result = await useCase.render('pushing', 1);

    expect(result.nextPhase).toBeNull();
  });

  it('honors unit.phaseConfig disabling a phase when computing nextPhase', async () => {
    const repos = makeRepos({
      unit: { findById: vi.fn(() => makeUnit({ phaseConfig: { implementing: { enabled: false } } })) },
    });
    const useCase = makeUseCase(repos);

    const result = await useCase.render('planning', 1);

    expect(result.nextPhase).toBe('reviewing');
  });

  it('resolves the unit-configured sidekick override for a phase', async () => {
    const overrideSidekick = makeSidekick('planning', 'Custom planning body for {{task.title}}', 'custom-planning');
    const repos = makeRepos({
      unit: { findById: vi.fn(() => makeUnit({ phaseConfig: { planning: { sidekick: 'custom-planning' } } })) },
      sidekickLoader: { findByName: vi.fn((name) => (name === 'custom-planning' ? overrideSidekick : null)) },
    });
    const useCase = makeUseCase(repos);

    const result = await useCase.render('planning', 1);

    expect(result.prompt).toContain('Custom planning body for Test Task');
  });

  it('throws when the unit-configured sidekick does not exist', async () => {
    const repos = makeRepos({
      unit: { findById: vi.fn(() => makeUnit({ phaseConfig: { planning: { sidekick: 'missing' } } })) },
      sidekickLoader: { findByName: vi.fn(() => null) },
    });
    const useCase = makeUseCase(repos);

    await expect(useCase.render('planning', 1)).rejects.toThrow('Sidekick "missing" configured for phase "planning" was not found');
  });

  it('throws when task not found', async () => {
    const repos = makeRepos({ task: { findById: vi.fn(() => null) } });
    const useCase = makeUseCase(repos);

    await expect(useCase.render('planning', 999)).rejects.toThrow('Task not found: 999');
  });

  it('throws when project not found', async () => {
    const repos = makeRepos({ project: { findById: vi.fn(() => null) } });
    const useCase = makeUseCase(repos);

    await expect(useCase.render('planning', 1)).rejects.toThrow('Project not found: 10');
  });

  it('throws when no default sidekick is configured for the phase', async () => {
    const repos = makeRepos({
      sidekickLoader: { findDefaultForTag: vi.fn(() => null) },
    });
    const useCase = makeUseCase(repos);

    await expect(useCase.render('planning', 1)).rejects.toThrow('No default Sidekick package is configured for phase "planning"');
  });

  it('prompt does not contain state-machine markers', async () => {
    const repos = makeRepos({
      sidekickLoader: {
        findDefaultForTag: vi.fn(() => makeSidekick('planning', 'Work on PHASE_COMPLETE and QUESTIONS_JSON')),
      },
    });
    const useCase = makeUseCase(repos);

    const result = await useCase.render('planning', 1);

    expect(result.prompt).not.toContain('PHASE_COMPLETE');
    expect(result.prompt).not.toContain('QUESTIONS_JSON');
  });

  describe('sidekick.dir resolution (Issue #263 Phase 6)', () => {
    it('uses the package dir as-is for a local server (no sync)', async () => {
      const pkg = makeSidekick('planning', 'Dir: {{sidekick.dir}}');
      const repos = makeRepos({ sidekickLoader: { findDefaultForTag: vi.fn(() => pkg) } });
      const useCase = makeUseCase(repos);

      const result = await useCase.render('planning', 1);

      expect(result.prompt).toContain(`Dir: ${pkg.dir}`);
      expect(repos.sidekickSyncService.sync).not.toHaveBeenCalled();
    });

    it('syncs and rewrites the dir to the remote path for an ssh server', async () => {
      const pkg = makeSidekick('planning', 'Dir: {{sidekick.dir}}');
      const repos = makeRepos({
        task: { findById: vi.fn(() => makeTask({ serverName: 'staging' })) },
        serverRepo: { findByName: vi.fn(() => makeServer({ name: 'staging', type: 'agent', sshHost: 'staging-host' })) },
        sidekickLoader: { findDefaultForTag: vi.fn(() => pkg), list: vi.fn(() => [pkg]) },
      });
      const useCase = makeUseCase(repos);

      const result = await useCase.render('planning', 1);

      expect(repos.sidekickSyncService.sync).toHaveBeenCalledWith('staging', expect.anything(), [pkg]);
      expect(result.prompt).toContain(`Dir: ~/.azito/sidekicks/${pkg.name}`);
    });

    it('falls back to the local dir when the task server cannot be resolved (best-effort, no sync)', async () => {
      const pkg = makeSidekick('planning', 'Dir: {{sidekick.dir}}');
      const repos = makeRepos({
        task: { findById: vi.fn(() => makeTask({ serverName: null })) },
        projectServer: { findByProject: vi.fn(() => []) },
        sidekickLoader: { findDefaultForTag: vi.fn(() => pkg) },
      });
      const useCase = makeUseCase(repos);

      const result = await useCase.render('planning', 1);

      expect(result.prompt).toContain(`Dir: ${pkg.dir}`);
      expect(repos.sidekickSyncService.sync).not.toHaveBeenCalled();
    });

    it('propagates a sync failure (fail fast)', async () => {
      const pkg = makeSidekick('planning', 'Dir: {{sidekick.dir}}');
      const repos = makeRepos({
        task: { findById: vi.fn(() => makeTask({ serverName: 'staging' })) },
        serverRepo: { findByName: vi.fn(() => makeServer({ name: 'staging', type: 'agent' })) },
        sidekickLoader: { findDefaultForTag: vi.fn(() => pkg) },
        sidekickSyncService: { sync: vi.fn(async () => { throw new Error('Sidekick sync to server "staging" failed: boom'); }) },
      });
      const useCase = makeUseCase(repos);

      await expect(useCase.render('planning', 1)).rejects.toThrow('Sidekick sync to server "staging" failed');
    });
  });
});
