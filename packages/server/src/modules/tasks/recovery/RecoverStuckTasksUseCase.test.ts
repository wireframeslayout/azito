import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { RecoverStuckTasksUseCase, type RecoveryLogger } from './RecoverStuckTasksUseCase';
import type { Task, ITaskRepository } from '../Task';
import type { TaskStatus } from '../TaskStatus';
import type { Unit, IUnitRepository } from '../../units/Unit';
import type { IExecutionLogRepository, ExecutionLog } from '../ExecutionLog';
import type { ServerConfig } from '../../servers/Server';
import type { AgentTurn, AgentTurnStatus } from '../turns/AgentTurn';

vi.mock('fs');

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 1,
    projectId: 1,
    unitId: 1,
    serverName: 'local-server',
    title: 'Test task',
    description: null,
    status: 'running',
    currentPhase: 'implementing',
    selfReviewCount: 0,
    priority: 0,
    tmuxWindow: 'task-1',
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
    createdAt: '2026-06-16T00:00:00Z',
    updatedAt: '2026-06-16T00:00:00Z',
    ...overrides,
  };
}

function makeUnit(overrides: Partial<Unit> = {}): Unit {
  return {
    id: 1,
    name: 'bucky',
    unitType: 'devops',
    systemPrompt: null,
    selfReviewMaxAttempts: 1,
    reviewSubagent: null,
    implementSubagent: null,
    phaseConfig: null,
    workerType: null,
    workerModel: null,
    workerExtraArgs: null,
    workerExecutionMode: 'tmux-pipe',
    workerRuntime: 'tui',
    createdAt: '2026-06-16T00:00:00Z',
    updatedAt: '2026-06-16T00:00:00Z',
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
    createdAt: '2026-06-16T00:00:00Z',
    ...overrides,
  };
}

function makeAgentTurn(overrides: Partial<AgentTurn> = {}): AgentTurn {
  return {
    id: 1,
    taskId: 1,
    unitId: 1,
    kind: 'phase',
    phase: 'implementing',
    nonce: 'abc',
    status: 'running' as AgentTurnStatus,
    completionSource: null,
    confidence: null,
    serverName: 'local-server',
    tmuxTarget: null,
    outputFilePath: null,
    startedAt: '2026-06-16T00:00:00Z',
    endedAt: null,
    ...overrides,
  };
}

function makePhasePromptLog(taskId: number, phase: string, doneMarker: string): ExecutionLog {
  return {
    id: 100,
    taskId,
    unitId: 1,
    type: 'command',
    content: JSON.stringify({ type: 'phase_prompt', phase, doneMarker, questionsMarker: `AZITO_QUESTIONS_${taskId}_abc` }),
    createdAt: '2026-06-16T08:00:00Z',
  };
}

interface Mocks {
  taskRepo: {
    findByStatus: ReturnType<typeof vi.fn>;
    updateStatus: ReturnType<typeof vi.fn>;
    updateCurrentPhase: ReturnType<typeof vi.fn>;
    [key: string]: unknown;
  };
  unitRepo: {
    findById: ReturnType<typeof vi.fn>;
    [key: string]: unknown;
  };
  serverRepo: {
    findByName: ReturnType<typeof vi.fn>;
    [key: string]: unknown;
  };
  projectRepo: {
    findById: ReturnType<typeof vi.fn>;
    [key: string]: unknown;
  };
  projectServerRepo: {
    find: ReturnType<typeof vi.fn>;
    findByProject: ReturnType<typeof vi.fn>;
    [key: string]: unknown;
  };
  logRepo: {
    findByTask: ReturnType<typeof vi.fn>;
    [key: string]: unknown;
  };
  tmuxClient: {
    capturePane: ReturnType<typeof vi.fn>;
    sendKeys: ReturnType<typeof vi.fn>;
    [key: string]: unknown;
  };
  executeTaskUseCase: {
    getRunning: ReturnType<typeof vi.fn>;
    resumeStateMachine: ReturnType<typeof vi.fn>;
    isPushCompleted: ReturnType<typeof vi.fn>;
    [key: string]: unknown;
  };
  turnRepo: {
    findLatestByTaskPhase: ReturnType<typeof vi.fn>;
    supersedeRunning: ReturnType<typeof vi.fn>;
    findLatestEventByType: ReturnType<typeof vi.fn>;
    [key: string]: unknown;
  };
  logger: RecoveryLogger;
}

function createMocks(): Mocks {
  return {
    taskRepo: {
      findByStatus: vi.fn().mockReturnValue([]),
      updateStatus: vi.fn(),
      updateCurrentPhase: vi.fn(),
      findAll: vi.fn(),
      findByProject: vi.fn(),
      findByUnit: vi.fn(),
      findById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      touch: vi.fn(),
      delete: vi.fn(),
    },
    unitRepo: {
      findById: vi.fn().mockReturnValue(makeUnit()),
      findAll: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    serverRepo: {
      findByName: vi.fn().mockReturnValue(makeServer()),
    },
    projectRepo: {
      findById: vi.fn().mockReturnValue({ id: 1, defaultUnitId: null }),
    },
    projectServerRepo: {
      find: vi.fn().mockReturnValue({ projectId: 1, serverName: 'local-server', workingDirectory: null, branch: null, tmuxSession: 'operation-bucky' }),
      findByProject: vi.fn().mockReturnValue([{ projectId: 1, serverName: 'local-server', workingDirectory: null, branch: null, tmuxSession: 'operation-bucky' }]),
    },
    logRepo: {
      findByTask: vi.fn().mockReturnValue([]),
      append: vi.fn(),
      findByUnit: vi.fn(),
    },
    tmuxClient: {
      resolvePaneId: vi.fn().mockResolvedValue('%0'),
      capturePane: vi.fn().mockResolvedValue({ stdout: 'pane content', code: 0 }),
      sendKeys: vi.fn().mockResolvedValue(undefined),
    },
    executeTaskUseCase: {
      getRunning: vi.fn().mockReturnValue({}),
      resumeStateMachine: vi.fn().mockResolvedValue(undefined),
      isPushCompleted: vi.fn().mockResolvedValue(false),
    },
    turnRepo: {
      findLatestByTaskPhase: vi.fn().mockReturnValue(null),
      supersedeRunning: vi.fn(),
      findLatestEventByType: vi.fn().mockReturnValue(null),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createUseCase(mocks: Mocks): RecoverStuckTasksUseCase {
  return new RecoverStuckTasksUseCase(
    mocks.taskRepo as any,
    mocks.unitRepo as any,
    mocks.serverRepo as any,
    mocks.projectRepo as any,
    mocks.projectServerRepo as any,
    mocks.logRepo as any,
    mocks.tmuxClient as any,
    mocks.executeTaskUseCase as any,
    mocks.turnRepo as any,
    mocks.logger,
    (() => {
      const devopsType = { name: 'devops', label: 'DevOps', description: '', phases: [
        { name: 'planning', label: 'Planning', tags: ['planning'], questions: true, testFailed: false, planApproval: true, selfReviewRetry: false, pushVerify: false, skillCommand: 'azt-plan' },
        { name: 'implementing', label: 'Implementing', tags: ['implementing'], questions: true, testFailed: false, planApproval: false, selfReviewRetry: false, pushVerify: false, subagentRole: 'implement', skillCommand: 'azt-implement' },
        { name: 'reviewing', label: 'Reviewing', tags: ['reviewing'], questions: false, testFailed: false, planApproval: false, selfReviewRetry: true, pushVerify: false, subagentRole: 'review', skillCommand: 'azt-review' },
        { name: 'testing', label: 'Testing', tags: ['testing'], questions: false, testFailed: true, planApproval: false, selfReviewRetry: false, pushVerify: false, testFailedRollbackTo: 'reviewing', skillCommand: 'azt-test' },
        { name: 'pushing', label: 'Pushing', tags: ['pushing'], questions: false, testFailed: false, planApproval: false, selfReviewRetry: false, pushVerify: true, skillCommand: 'azt-push' },
      ] };
      return { getOrThrow: vi.fn(() => devopsType), get: vi.fn(() => devopsType) };
    })() as any,
  );
}

describe('RecoverStuckTasksUseCase', () => {
  let mocks: Mocks;

  beforeEach(() => {
    mocks = createMocks();
    vi.mocked(fs.readdirSync).mockReturnValue([]);
    vi.mocked(fs.readFileSync).mockReturnValue('');
  });

  it('should skip when no stuck tasks exist', async () => {
    const useCase = createUseCase(mocks);
    await useCase.run();
    expect(mocks.executeTaskUseCase.resumeStateMachine).not.toHaveBeenCalled();
  });

  it('should fall back to project.defaultUnitId when task.unitId is null', async () => {
    const task = makeTask({ id: 30, unitId: null });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'running' ? [task] : [],
    );
    mocks.projectRepo.findById.mockReturnValue({ id: 1, defaultUnitId: 7 });
    mocks.unitRepo.findById.mockReturnValue(makeUnit({ id: 7 }));
    mocks.logRepo.findByTask.mockReturnValue([
      makePhasePromptLog(30, 'implementing', 'AZITO_DONE_30_dflt'),
    ]);
    vi.mocked(fs.readdirSync).mockReturnValue([]);

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(mocks.unitRepo.findById).toHaveBeenCalledWith(7);
    expect(mocks.executeTaskUseCase.resumeStateMachine).toHaveBeenCalledWith(7, 30);
  });

  it('should skip when neither task.unitId nor project.defaultUnitId is set', async () => {
    const task = makeTask({ id: 31, unitId: null });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'running' ? [task] : [],
    );
    mocks.projectRepo.findById.mockReturnValue({ id: 1, defaultUnitId: null });

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(mocks.executeTaskUseCase.resumeStateMachine).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('no unit resolvable'));
  });

  it('should advance to next phase when marker found (complete)', async () => {
    const task = makeTask({ id: 10 });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'running' ? [task] : [],
    );
    const doneMarker = 'AZITO_DONE_10_abc123';
    mocks.logRepo.findByTask.mockReturnValue([
      makePhasePromptLog(10, 'implementing', doneMarker),
    ]);
    vi.mocked(fs.readdirSync).mockReturnValue([
      'azito-pipe-10-sig-1234567890.log' as any,
    ]);
    vi.mocked(fs.readFileSync).mockReturnValue(`some output\n${doneMarker}\nmore`);

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(mocks.taskRepo.updateStatus).toHaveBeenCalledWith(10, 'running');
    expect(mocks.taskRepo.updateCurrentPhase).toHaveBeenCalledWith(10, 'reviewing');
    expect(mocks.executeTaskUseCase.resumeStateMachine).toHaveBeenCalledWith(1, 10);
    expect(mocks.tmuxClient.sendKeys).toHaveBeenCalled();
  });

  it('should retry current phase when marker not found (incomplete)', async () => {
    const task = makeTask({ id: 11 });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'running' ? [task] : [],
    );
    mocks.logRepo.findByTask.mockReturnValue([
      makePhasePromptLog(11, 'implementing', 'AZITO_DONE_11_xyz'),
    ]);
    vi.mocked(fs.readdirSync).mockReturnValue([]);

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(mocks.taskRepo.updateStatus).not.toHaveBeenCalled();
    expect(mocks.executeTaskUseCase.resumeStateMachine).toHaveBeenCalledWith(1, 11);
  });

  it('should set review status for completed pushing without resuming', async () => {
    const task = makeTask({ id: 12, currentPhase: 'pushing' });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'running' ? [task] : [],
    );
    const doneMarker = 'AZITO_DONE_12_push1';
    mocks.logRepo.findByTask.mockReturnValue([
      makePhasePromptLog(12, 'pushing', doneMarker),
    ]);
    vi.mocked(fs.readdirSync).mockReturnValue([
      'azito-pipe-12-sig-999.log' as any,
    ]);
    vi.mocked(fs.readFileSync).mockReturnValue(doneMarker);

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(mocks.taskRepo.updateStatus).toHaveBeenCalledWith(12, 'review');
    expect(mocks.executeTaskUseCase.resumeStateMachine).not.toHaveBeenCalled();
  });

  it('should skip tasks on non-local servers', async () => {
    const task = makeTask({ id: 13 });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'running' ? [task] : [],
    );
    mocks.serverRepo.findByName.mockReturnValue(makeServer({ type: 'agent' }));

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(mocks.executeTaskUseCase.resumeStateMachine).not.toHaveBeenCalled();
  });

  it('should skip tasks already running', async () => {
    const task = makeTask({ id: 14 });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'running' ? [task] : [],
    );
    mocks.executeTaskUseCase.getRunning.mockReturnValue({
      1: [{ taskId: 14, target: 'operation-bucky:task-14.1' }],
    });

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(mocks.executeTaskUseCase.resumeStateMachine).not.toHaveBeenCalled();
  });

  it('should skip tasks when pane is dead', async () => {
    const task = makeTask({ id: 15 });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'running' ? [task] : [],
    );
    mocks.tmuxClient.capturePane.mockRejectedValue(new Error('pane not found'));

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(mocks.executeTaskUseCase.resumeStateMachine).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('pane dead'));
  });

  it('should not detect terminal statuses as stuck', async () => {
    mocks.taskRepo.findByStatus.mockReturnValue([]);

    const useCase = createUseCase(mocks);
    await useCase.run();

    const calledStatuses = mocks.taskRepo.findByStatus.mock.calls.map((c: unknown[]) => c[0]);
    expect(calledStatuses).toContain('running');
    expect(calledStatuses).toContain('in_progress');
    expect(calledStatuses).not.toContain('review');
    expect(calledStatuses).not.toContain('done');
    expect(calledStatuses).not.toContain('failed');
    expect(calledStatuses).not.toContain('open');
  });

  it('should fallback to current phase retry when sig files missing', async () => {
    const task = makeTask({ id: 16, currentPhase: 'reviewing' });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'running' ? [task] : [],
    );
    mocks.logRepo.findByTask.mockReturnValue([
      makePhasePromptLog(16, 'reviewing', 'AZITO_DONE_16_rev1'),
    ]);
    vi.mocked(fs.readdirSync).mockImplementation(() => { throw new Error('ENOENT'); });

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(mocks.taskRepo.updateStatus).not.toHaveBeenCalled();
    expect(mocks.executeTaskUseCase.resumeStateMachine).toHaveBeenCalledWith(1, 16);
  });

  it('should use isPushCompleted as fallback for pushing phase without marker', async () => {
    const task = makeTask({ id: 17, currentPhase: 'pushing' });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'running' ? [task] : [],
    );
    mocks.logRepo.findByTask.mockReturnValue([
      makePhasePromptLog(17, 'pushing', 'AZITO_DONE_17_push'),
    ]);
    vi.mocked(fs.readdirSync).mockReturnValue([]);
    mocks.executeTaskUseCase.isPushCompleted.mockResolvedValue(true);

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(mocks.executeTaskUseCase.isPushCompleted).toHaveBeenCalledWith(17);
    expect(mocks.taskRepo.updateStatus).toHaveBeenCalledWith(17, 'review');
    expect(mocks.executeTaskUseCase.resumeStateMachine).not.toHaveBeenCalled();
  });

  it('should send Escape before resuming', async () => {
    const task = makeTask({ id: 18, currentPhase: 'testing', tmuxWindow: 'task-18' });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'running' ? [task] : [],
    );

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(mocks.tmuxClient.sendKeys).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'local' }),
      '%0',
      ['Escape'],
    );
  });

  it('should resolve phase from execution_log for in_progress tasks', async () => {
    const task = makeTask({ id: 19, status: 'in_progress', currentPhase: null, tmuxWindow: 'task-19' });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'in_progress' ? [task] : [],
    );
    mocks.logRepo.findByTask.mockReturnValue([
      makePhasePromptLog(19, 'planning', 'AZITO_DONE_19_plan1'),
    ]);
    vi.mocked(fs.readdirSync).mockReturnValue([]);

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(mocks.taskRepo.updateStatus).toHaveBeenCalledWith(19, 'running');
    expect(mocks.taskRepo.updateCurrentPhase).toHaveBeenCalledWith(19, 'planning');
    expect(mocks.executeTaskUseCase.resumeStateMachine).toHaveBeenCalledWith(1, 19);
  });

  it('should skip in_progress task when no phase_prompt in logs', async () => {
    const task = makeTask({ id: 20, status: 'in_progress', currentPhase: null, tmuxWindow: 'task-20' });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'in_progress' ? [task] : [],
    );
    mocks.logRepo.findByTask.mockReturnValue([]);

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(mocks.executeTaskUseCase.resumeStateMachine).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('cannot determine phase'));
  });

  it('should advance in_progress task when phase is complete', async () => {
    const task = makeTask({ id: 21, status: 'in_progress', currentPhase: null, tmuxWindow: 'task-21' });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'in_progress' ? [task] : [],
    );
    const doneMarker = 'AZITO_DONE_21_impl1';
    mocks.logRepo.findByTask.mockReturnValue([
      makePhasePromptLog(21, 'implementing', doneMarker),
    ]);
    vi.mocked(fs.readdirSync).mockReturnValue([
      'azito-pipe-21-sig-999.log' as any,
    ]);
    vi.mocked(fs.readFileSync).mockReturnValue(doneMarker);

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(mocks.taskRepo.updateStatus).toHaveBeenCalledWith(21, 'running');
    expect(mocks.taskRepo.updateCurrentPhase).toHaveBeenCalledWith(21, 'reviewing');
    expect(mocks.executeTaskUseCase.resumeStateMachine).toHaveBeenCalledWith(1, 21);
  });

  it('should advance http-signal task to next phase when turn is completed (DB-driven)', async () => {
    const task = makeTask({ id: 22 });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'running' ? [task] : [],
    );
    mocks.unitRepo.findById.mockReturnValue(makeUnit({ workerExecutionMode: 'http-signal' }));
    mocks.turnRepo.findLatestByTaskPhase.mockReturnValue(
      makeAgentTurn({ id: 5, taskId: 22, phase: 'implementing', status: 'completed' }),
    );
    const callsBefore = vi.mocked(fs.readdirSync).mock.calls.length;

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(mocks.turnRepo.findLatestByTaskPhase).toHaveBeenCalledWith(22, 'implementing');
    expect(vi.mocked(fs.readdirSync).mock.calls.length).toBe(callsBefore);
    expect(mocks.taskRepo.updateStatus).toHaveBeenCalledWith(22, 'running');
    expect(mocks.taskRepo.updateCurrentPhase).toHaveBeenCalledWith(22, 'reviewing');
    expect(mocks.executeTaskUseCase.resumeStateMachine).toHaveBeenCalledWith(1, 22);
  });

  it('should retry current phase for http-signal task when turn is running, without scanning signal files', async () => {
    const task = makeTask({ id: 23 });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'running' ? [task] : [],
    );
    mocks.unitRepo.findById.mockReturnValue(makeUnit({ workerExecutionMode: 'http-signal' }));
    mocks.turnRepo.findLatestByTaskPhase.mockReturnValue(
      makeAgentTurn({ id: 6, taskId: 23, phase: 'implementing', status: 'running' }),
    );
    const callsBefore = vi.mocked(fs.readdirSync).mock.calls.length;

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(vi.mocked(fs.readdirSync).mock.calls.length).toBe(callsBefore);
    expect(mocks.taskRepo.updateStatus).not.toHaveBeenCalled();
    expect(mocks.executeTaskUseCase.resumeStateMachine).toHaveBeenCalledWith(1, 23);
  });

  it('should fall back to signal file scanning for tmux-pipe tasks (turn table not decisive)', async () => {
    const task = makeTask({ id: 24 });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'running' ? [task] : [],
    );
    mocks.unitRepo.findById.mockReturnValue(makeUnit({ workerExecutionMode: 'tmux-pipe' }));
    mocks.turnRepo.findLatestByTaskPhase.mockReturnValue(null);
    const doneMarker = 'AZITO_DONE_24_tmux1';
    mocks.logRepo.findByTask.mockReturnValue([
      makePhasePromptLog(24, 'implementing', doneMarker),
    ]);
    vi.mocked(fs.readdirSync).mockReturnValue([
      'azito-pipe-24-sig-1.log' as any,
    ]);
    vi.mocked(fs.readFileSync).mockReturnValue(doneMarker);

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(fs.readdirSync).toHaveBeenCalled();
    expect(mocks.taskRepo.updateStatus).toHaveBeenCalledWith(24, 'running');
    expect(mocks.taskRepo.updateCurrentPhase).toHaveBeenCalledWith(24, 'reviewing');
    expect(mocks.executeTaskUseCase.resumeStateMachine).toHaveBeenCalledWith(1, 24);
  });

  it('should treat http-signal task on an ssh server as recoverable', async () => {
    const task = makeTask({ id: 25 });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'running' ? [task] : [],
    );
    mocks.unitRepo.findById.mockReturnValue(makeUnit({ workerExecutionMode: 'http-signal' }));
    mocks.serverRepo.findByName.mockReturnValue(makeServer({ type: 'agent' }));
    mocks.turnRepo.findLatestByTaskPhase.mockReturnValue(
      makeAgentTurn({ id: 7, taskId: 25, phase: 'implementing', status: 'completed' }),
    );

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(mocks.taskRepo.updateStatus).toHaveBeenCalledWith(25, 'running');
    expect(mocks.taskRepo.updateCurrentPhase).toHaveBeenCalledWith(25, 'reviewing');
    expect(mocks.executeTaskUseCase.resumeStateMachine).toHaveBeenCalledWith(1, 25);
  });

  it('should still skip tmux-pipe tasks on non-local servers', async () => {
    const task = makeTask({ id: 26 });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'running' ? [task] : [],
    );
    mocks.unitRepo.findById.mockReturnValue(makeUnit({ workerExecutionMode: 'tmux-pipe' }));
    mocks.serverRepo.findByName.mockReturnValue(makeServer({ type: 'agent' }));

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(mocks.executeTaskUseCase.resumeStateMachine).not.toHaveBeenCalled();
  });

  it('should treat http-signal task on an ssh server as recoverable', async () => {
    const task = makeTask({ id: 28 });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'running' ? [task] : [],
    );
    mocks.unitRepo.findById.mockReturnValue(makeUnit({ workerExecutionMode: 'http-signal' }));
    mocks.serverRepo.findByName.mockReturnValue(makeServer({ type: 'agent' }));
    mocks.turnRepo.findLatestByTaskPhase.mockReturnValue(
      makeAgentTurn({ id: 9, taskId: 28, phase: 'implementing', status: 'completed' }),
    );
    const callsBefore = vi.mocked(fs.readdirSync).mock.calls.length;

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(vi.mocked(fs.readdirSync).mock.calls.length).toBe(callsBefore);
    expect(mocks.taskRepo.updateStatus).toHaveBeenCalledWith(28, 'running');
    expect(mocks.taskRepo.updateCurrentPhase).toHaveBeenCalledWith(28, 'reviewing');
    expect(mocks.executeTaskUseCase.resumeStateMachine).toHaveBeenCalledWith(1, 28);
  });

  it('should still fall back to signal file scanning for tmux-pipe tasks even with turn table available (unchanged)', async () => {
    const task = makeTask({ id: 29 });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'running' ? [task] : [],
    );
    mocks.unitRepo.findById.mockReturnValue(makeUnit({ workerExecutionMode: 'tmux-pipe' }));
    mocks.turnRepo.findLatestByTaskPhase.mockReturnValue(null);
    const doneMarker = 'AZITO_DONE_29_tmux2';
    mocks.logRepo.findByTask.mockReturnValue([
      makePhasePromptLog(29, 'implementing', doneMarker),
    ]);
    vi.mocked(fs.readdirSync).mockReturnValue([
      'azito-pipe-29-sig-1.log' as any,
    ]);
    vi.mocked(fs.readFileSync).mockReturnValue(doneMarker);

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(fs.readdirSync).toHaveBeenCalled();
    expect(mocks.taskRepo.updateStatus).toHaveBeenCalledWith(29, 'running');
    expect(mocks.taskRepo.updateCurrentPhase).toHaveBeenCalledWith(29, 'reviewing');
    expect(mocks.executeTaskUseCase.resumeStateMachine).toHaveBeenCalledWith(1, 29);
  });

  it('should call supersedeRunning before resuming', async () => {
    const task = makeTask({ id: 27 });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'running' ? [task] : [],
    );
    mocks.unitRepo.findById.mockReturnValue(makeUnit({ workerExecutionMode: 'http-signal' }));
    mocks.turnRepo.findLatestByTaskPhase.mockReturnValue(
      makeAgentTurn({ id: 8, taskId: 27, phase: 'implementing', status: 'running' }),
    );

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(mocks.turnRepo.supersedeRunning).toHaveBeenCalledWith(27);
    expect(mocks.turnRepo.supersedeRunning.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.executeTaskUseCase.resumeStateMachine.mock.invocationCallOrder[0],
    );
  });

  it('should restore planMarkdown and stop at planning_review for approved-plan http-signal task', async () => {
    const task = makeTask({ id: 28, currentPhase: 'planning', requirePlanApproval: true });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'running' ? [task] : [],
    );
    mocks.unitRepo.findById.mockReturnValue(makeUnit({ workerExecutionMode: 'http-signal' }));
    mocks.turnRepo.findLatestByTaskPhase.mockReturnValue(
      makeAgentTurn({ id: 9, taskId: 28, phase: 'planning', status: 'completed' }),
    );
    mocks.turnRepo.findLatestEventByType.mockReturnValue({
      id: 1, turnId: 9, type: 'complete', payload: JSON.stringify({ output: '# Plan\n- step 1' }), source: 'azitoctl', createdAt: '2026-06-16T00:00:00Z',
    });

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(mocks.turnRepo.findLatestEventByType).toHaveBeenCalledWith(9, 'complete');
    expect(mocks.taskRepo.update).toHaveBeenCalledWith(28, { planMarkdown: '# Plan\n- step 1' });
    expect(mocks.taskRepo.updateStatus).toHaveBeenCalledWith(28, 'phase_review');
    expect(mocks.executeTaskUseCase.resumeStateMachine).not.toHaveBeenCalled();
  });

  it('should restore planMarkdown and advance to implementing when plan approval is not required', async () => {
    const task = makeTask({ id: 29, currentPhase: 'planning', requirePlanApproval: false });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'running' ? [task] : [],
    );
    mocks.unitRepo.findById.mockReturnValue(makeUnit({ workerExecutionMode: 'http-signal' }));
    mocks.turnRepo.findLatestByTaskPhase.mockReturnValue(
      makeAgentTurn({ id: 10, taskId: 29, phase: 'planning', status: 'completed' }),
    );
    mocks.turnRepo.findLatestEventByType.mockReturnValue({
      id: 2, turnId: 10, type: 'complete', payload: JSON.stringify({ output: '# Plan body' }), source: 'azitoctl', createdAt: '2026-06-16T00:00:00Z',
    });

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(mocks.taskRepo.update).toHaveBeenCalledWith(29, { planMarkdown: '# Plan body' });
    expect(mocks.taskRepo.updateStatus).toHaveBeenCalledWith(29, 'running');
    expect(mocks.taskRepo.updateCurrentPhase).toHaveBeenCalledWith(29, 'implementing');
    expect(mocks.executeTaskUseCase.resumeStateMachine).toHaveBeenCalledWith(1, 29);
  });

  it('should bump selfReviewCount and go back to reviewing for test_failed turn under the self-review limit', async () => {
    const task = makeTask({ id: 30, currentPhase: 'testing', selfReviewCount: 0 });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'running' ? [task] : [],
    );
    mocks.unitRepo.findById.mockReturnValue(
      makeUnit({ workerExecutionMode: 'http-signal', selfReviewMaxAttempts: 2 }),
    );
    mocks.turnRepo.findLatestByTaskPhase.mockReturnValue(
      makeAgentTurn({ id: 11, taskId: 30, phase: 'testing', status: 'test_failed' }),
    );

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(mocks.taskRepo.update).toHaveBeenCalledWith(30, { selfReviewCount: 1 });
    expect(mocks.taskRepo.updateStatus).toHaveBeenCalledWith(30, 'running');
    expect(mocks.taskRepo.updateCurrentPhase).toHaveBeenCalledWith(30, 'reviewing');
    expect(mocks.executeTaskUseCase.resumeStateMachine).toHaveBeenCalledWith(1, 30);
  });

  it('should advance past testing for test_failed turn at the self-review limit', async () => {
    const task = makeTask({ id: 31, currentPhase: 'testing', selfReviewCount: 1 });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'running' ? [task] : [],
    );
    mocks.unitRepo.findById.mockReturnValue(
      makeUnit({ workerExecutionMode: 'http-signal', selfReviewMaxAttempts: 2 }),
    );
    mocks.turnRepo.findLatestByTaskPhase.mockReturnValue(
      makeAgentTurn({ id: 12, taskId: 31, phase: 'testing', status: 'test_failed' }),
    );

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(mocks.taskRepo.update).not.toHaveBeenCalled();
    expect(mocks.taskRepo.updateStatus).toHaveBeenCalledWith(31, 'running');
    expect(mocks.taskRepo.updateCurrentPhase).toHaveBeenCalledWith(31, 'pushing');
    expect(mocks.executeTaskUseCase.resumeStateMachine).toHaveBeenCalledWith(1, 31);
  });

  it('should restore pendingQuestions and stop at waiting_input for questions turn', async () => {
    const task = makeTask({ id: 32 });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'running' ? [task] : [],
    );
    mocks.unitRepo.findById.mockReturnValue(makeUnit({ workerExecutionMode: 'http-signal' }));
    mocks.turnRepo.findLatestByTaskPhase.mockReturnValue(
      makeAgentTurn({ id: 13, taskId: 32, phase: 'implementing', status: 'questions' }),
    );
    const questions = [{ question: 'Which base branch?', type: 'text' }];
    mocks.turnRepo.findLatestEventByType.mockReturnValue({
      id: 3, turnId: 13, type: 'questions', payload: JSON.stringify({ questions }), source: 'azitoctl', createdAt: '2026-06-16T00:00:00Z',
    });

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(mocks.turnRepo.findLatestEventByType).toHaveBeenCalledWith(13, 'questions');
    expect(mocks.taskRepo.update).toHaveBeenCalledWith(32, { pendingQuestions: JSON.stringify(questions) });
    expect(mocks.taskRepo.updateStatus).toHaveBeenCalledWith(32, 'waiting_input');
    expect(mocks.executeTaskUseCase.resumeStateMachine).not.toHaveBeenCalled();
  });

  it('should retry current phase when questions turn has no recoverable payload', async () => {
    const task = makeTask({ id: 33 });
    mocks.taskRepo.findByStatus.mockImplementation((status: TaskStatus) =>
      status === 'running' ? [task] : [],
    );
    mocks.unitRepo.findById.mockReturnValue(makeUnit({ workerExecutionMode: 'http-signal' }));
    mocks.turnRepo.findLatestByTaskPhase.mockReturnValue(
      makeAgentTurn({ id: 14, taskId: 33, phase: 'implementing', status: 'questions' }),
    );
    mocks.turnRepo.findLatestEventByType.mockReturnValue(null);

    const useCase = createUseCase(mocks);
    await useCase.run();

    expect(mocks.taskRepo.update).not.toHaveBeenCalled();
    expect(mocks.taskRepo.updateStatus).not.toHaveBeenCalledWith(33, 'waiting_input');
    expect(mocks.executeTaskUseCase.resumeStateMachine).toHaveBeenCalledWith(1, 33);
  });
});
