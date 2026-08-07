import { vi } from 'vitest';
import { PhaseLoopRunner } from './PhaseLoopRunner';
import { TuiWorkerRuntime } from './runtime/TuiWorkerRuntime';
import { WorkerRuntimeRegistry } from './runtime/WorkerRuntimeRegistry';
import type { SidekickPackage } from '../../sidekicks/SidekickPackage';

export function makeSidekick(overrides: Partial<SidekickPackage> = {}): SidekickPackage {
  return {
    name: 'planning-default',
    description: 'default',
    tags: ['planning'],
    isDefault: true,
    layer: 'builtin',
    overridesBuiltin: false,
    dir: '/harness/sidekicks/planning-default',
    body: 'Plan {{task.title}}',
    hasScripts: false,
    hasReferences: false,
    ...overrides,
  };
}

export function makeRunner(overrides: { sidekickLoader?: Record<string, unknown>; sidekickSyncService?: Record<string, unknown>; httpSignalCoordinator?: Record<string, unknown>; pullRequestCreator?: Record<string, unknown> } = {}) {
  const taskRepo = {
    findById: vi.fn(() => ({
      id: 1,
      projectId: 10,
      unitId: 1,
      serverName: 'local',
      title: 'Test Task',
      description: null,
      status: 'open',
      currentPhase: 'planning',
      planMarkdown: 'THE PLAN',
      targetBranch: null,
      baseBranch: null,
      skipPr: false,
      selfReviewCount: 0,
      worktreePath: null,
      workingDirectory: '/work',
      summaryJson: null,
    })),
    update: vi.fn(),
    updateStatus: vi.fn(),
    updateCurrentPhase: vi.fn(),
  };
  const projectRepo = {
    findById: vi.fn(() => ({ id: 10, sidekickPrompt: '', defaultBranch: 'main' })),
    findRepositoryById: vi.fn((() => null) as any),
  };
  const projectServerRepo = {
    find: vi.fn(() => null),
    findByProject: vi.fn(() => []),
  };
  const unitRepo = {
    findById: vi.fn(() => ({
      id: 1, unitType: 'devops', systemPrompt: null, selfReviewMaxAttempts: 2, reviewSubagent: null, implementSubagent: null, phaseConfig: null,
      workerType: null, workerModel: null, workerExtraArgs: null,
      workerExecutionMode: 'tmux-pipe',
    })),
  };
  const sidekickLoader = {
    findByName: vi.fn(() => null),
    findDefaultForTag: vi.fn(() => makeSidekick()),
    list: vi.fn(() => []),
    invalidateCache: vi.fn(),
    ...overrides.sidekickLoader,
  };
  const workerInput = {
    sendPrompt: vi.fn(async (_server: unknown, _target: string, _text: string, _ctx?: unknown) => {}),
    sendKeys: vi.fn(async (_server: unknown, _target: string, _keys: string[], _ctx?: unknown) => {}),
  };
  const workerWaiter = {
    startPaneStream: vi.fn(() => ({ stop: vi.fn() })),
    startSignalStream: vi.fn(() => ({ getFilePath: () => '/tmp/sig', stop: vi.fn() })),
    waitForWorker: vi.fn(async () => ({ output: 'PHASE_COMPLETE', classification: { status: 'phase_complete' } })),
    capturePaneText: vi.fn(async () => 'Thinking...'),
    readPhaseOutputFile: vi.fn(async (): Promise<string | null> => null),
    extractPlanWithFallback: vi.fn(async () => null),
  };
  const pushVerifier = { verifyPushCompleted: vi.fn(async () => true) };
  const gitInfoCollector = {
    collectGitInfoSync: vi.fn((): { branch: string | null; changedFiles: string | null } => ({ branch: null, changedFiles: null })),
    collectGitInfoRemote: vi.fn(async (): Promise<{ branch: string | null; changedFiles: string | null }> => ({ branch: null, changedFiles: null })),
    writeRemoteFile: vi.fn(async () => {}),
  };
  const gitProvider = { findPullRequestByBranch: vi.fn(async () => null) };
  const pullRequestCreator = { ensureCreated: vi.fn(async () => {}), ...overrides.pullRequestCreator };
  const getWorktreeService = vi.fn(() => ({ exists: vi.fn(async () => false) }));
  const appendLog = vi.fn();
  const transportFactory = { getTransport: vi.fn(() => ({ exec: vi.fn() })), invalidate: vi.fn() };
  const sidekickSyncService = { sync: vi.fn(async () => {}), ...overrides.sidekickSyncService };
  const httpSignalCoordinator = {
    start: vi.fn(() => ({
      turn: { id: 1, taskId: 1, unitId: 1, kind: 'phase', phase: 'planning', nonce: 'n', status: 'running', completionSource: null, confidence: null, serverName: 'local', tmuxTarget: 'sess:1.1', outputFilePath: '/tmp/out.md', startedAt: '2026-01-01T00:00:00Z', endedAt: null },
      signalStream: { on: vi.fn(), stop: vi.fn(), getFilePath: () => '(in-process)' },
      markerizedPrompt: 'http-signal prompt',
    })),
    finalize: vi.fn(async (_turnId: number, classification: unknown) => ({ classification, turn: null })),
    readOutput: vi.fn(() => null),
    rejectInferredCompletion: vi.fn(),
    ...overrides.httpSignalCoordinator,
  };

  const runner = new PhaseLoopRunner(
    taskRepo as any,
    projectRepo as any,
    projectServerRepo as any,
    unitRepo as any,
    sidekickLoader as any,
    workerWaiter as any,
    pushVerifier as any,
    gitInfoCollector as any,
    gitProvider as any,
    pullRequestCreator as any,
    getWorktreeService as any,
    appendLog as any,
    transportFactory as any,
    sidekickSyncService as any,
    httpSignalCoordinator as any,
    workerInput as any,
    { getOrThrow: vi.fn(() => ({ name: 'devops', label: 'DevOps', description: '', phases: [
      { name: 'planning', label: 'Planning', tags: ['planning'], questions: true, testFailed: false, planApproval: true, selfReviewRetry: false, pushVerify: false, skillCommand: 'azt-plan' },
      { name: 'implementing', label: 'Implementing', tags: ['implementing'], questions: true, testFailed: false, planApproval: false, selfReviewRetry: false, pushVerify: false, subagentRole: 'implement', skillCommand: 'azt-implement' },
      { name: 'reviewing', label: 'Reviewing', tags: ['reviewing'], questions: false, testFailed: false, planApproval: false, selfReviewRetry: true, pushVerify: false, subagentRole: 'review', skillCommand: 'azt-review' },
      { name: 'testing', label: 'Testing', tags: ['testing'], questions: false, testFailed: true, planApproval: false, selfReviewRetry: false, pushVerify: false, testFailedRollbackTo: 'reviewing', skillCommand: 'azt-test' },
      { name: 'pushing', label: 'Pushing', tags: ['pushing'], questions: false, testFailed: false, planApproval: false, selfReviewRetry: false, pushVerify: true, skillCommand: 'azt-push' },
    ] })) } as any,
    (() => {
      const tuiRuntime = new TuiWorkerRuntime({ sendKeys: vi.fn() } as any, workerInput as any, workerWaiter as any, httpSignalCoordinator as any);
      const registry = new WorkerRuntimeRegistry();
      registry.register('tui', tuiRuntime);
      return registry;
    })(),
  );

  return { runner, taskRepo, projectRepo, projectServerRepo, unitRepo, sidekickLoader, workerInput, workerWaiter, appendLog, getWorktreeService, transportFactory, sidekickSyncService, httpSignalCoordinator, pushVerifier, gitInfoCollector, gitProvider, pullRequestCreator };
}

export const server = { name: 'local', type: 'local' } as any;
export const task = { id: 1, projectId: 10, title: 'Test Task', description: null, status: 'open' as const, currentPhase: 'planning' as string | null };

export function makeUnitForRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 1, unitType: 'devops', systemPrompt: null, selfReviewMaxAttempts: 2, reviewSubagent: null, implementSubagent: null, phaseConfig: null,
    workerType: null, workerModel: null, workerExtraArgs: null,
    workerExecutionMode: 'tmux-pipe' as const,
    workerRuntime: 'tui' as const,
    ...overrides,
  };
}
