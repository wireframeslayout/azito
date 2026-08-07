import { describe, it, expect, vi } from 'vitest';
import { makeRunner, makeUnitForRun, server, task } from './PhaseLoopRunner.test-helpers';

function defaultSignal(): AbortSignal {
  return new AbortController().signal;
}

function calledPhaseTags(sidekickLoader: { findDefaultForTag: { mock: { calls: unknown[][] } } }): string[] {
  return sidekickLoader.findDefaultForTag.mock.calls.map(([phase]) => phase as string);
}

describe('state machine flow: happy path', () => {
  it('advances through all 5 phases and sets final status to review', async () => {
    const { runner, taskRepo, workerInput } = makeRunner();

    await runner.stateMachineLoop(makeUnitForRun(), 'local', task, server, 'sess:1.1', defaultSignal(), 'sess:1');

    expect(workerInput.sendPrompt).toHaveBeenCalledTimes(5);
    expect(taskRepo.updateStatus).toHaveBeenCalledWith(1, 'running');
    expect(taskRepo.updateStatus.mock.calls.filter(([, status]) => status === 'running')).toHaveLength(5);
    expect(taskRepo.updateCurrentPhase.mock.calls.map(([, phase]) => phase)).toEqual([
      'planning', 'implementing', 'reviewing', 'testing', 'pushing',
    ]);
    expect(taskRepo.updateStatus.mock.calls.at(-1)).toEqual([1, 'review']);
  });

  it('collects git info after all phases complete', async () => {
    const { runner, taskRepo, gitInfoCollector } = makeRunner();
    gitInfoCollector.collectGitInfoSync = vi.fn(() => ({ branch: 'task/1-test', changedFiles: 'M file.ts' }));

    await runner.stateMachineLoop(makeUnitForRun(), 'local', task, server, 'sess:1.1', defaultSignal(), 'sess:1');

    // '/work' comes from taskRepo.findById().workingDirectory (worktreePath is null, no projectServer)
    expect(gitInfoCollector.collectGitInfoSync).toHaveBeenCalledWith('/work', undefined);
    expect(taskRepo.update).toHaveBeenCalledWith(1, { branch: 'task/1-test', changedFiles: 'M file.ts' });
  });
});

describe('state machine flow: question', () => {
  it('sets status to waiting_input when worker reports a question', async () => {
    const { runner, taskRepo, workerInput, workerWaiter } = makeRunner();
    const questions = [{ text: 'Which DB?' }];
    workerWaiter.waitForWorker = vi.fn(async () => ({
      output: 'Need input',
      classification: { status: 'question', questions },
    }));

    await runner.stateMachineLoop(makeUnitForRun(), 'local', task, server, 'sess:1.1', defaultSignal(), 'sess:1');

    expect(taskRepo.updateStatus).toHaveBeenCalledWith(1, 'waiting_input');
    expect(taskRepo.update).toHaveBeenCalledWith(1, { pendingQuestions: JSON.stringify(questions) });
    expect(workerInput.sendPrompt).toHaveBeenCalledTimes(1);
  });
});

describe('state machine flow: plan approval', () => {
  it('sets status to phase_review when planApproval phase completes and task.requirePlanApproval is true', async () => {
    const { runner, taskRepo, workerInput } = makeRunner();
    taskRepo.findById = vi.fn(() => ({
      id: 1, projectId: 10, title: 'Test Task', description: null, status: 'running',
      currentPhase: 'planning', planMarkdown: 'THE PLAN', targetBranch: null, baseBranch: null, skipPr: false,
      selfReviewCount: 0, worktreePath: null, workingDirectory: '/work', summaryJson: null, requirePlanApproval: true,
    } as any));

    await runner.stateMachineLoop(makeUnitForRun(), 'local', task, server, 'sess:1.1', defaultSignal(), 'sess:1');

    expect(taskRepo.updateStatus).toHaveBeenCalledWith(1, 'phase_review');
    expect(workerInput.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('skips plan approval and continues when requirePlanApproval is false', async () => {
    const { runner, taskRepo, workerInput } = makeRunner();

    await runner.stateMachineLoop(makeUnitForRun(), 'local', task, server, 'sess:1.1', defaultSignal(), 'sess:1');

    expect(taskRepo.updateStatus).not.toHaveBeenCalledWith(1, 'phase_review');
    expect(workerInput.sendPrompt).toHaveBeenCalledTimes(5);
  });
});

describe('state machine flow: test failure rollback', () => {
  it('rolls back to reviewing when testing output contains testFailedMarker', async () => {
    const { runner, taskRepo, sidekickLoader, workerWaiter } = makeRunner();
    let callCount = 0;
    workerWaiter.waitForWorker = vi.fn(async (...args: unknown[]) => {
      callCount++;
      const doneMarker = args[6] as string;
      if (callCount === 4) {
        const testFailedMarker = doneMarker.replace('AZITO_DONE_', 'AZITO_TEST_FAILED_');
        return { output: `test failed ${testFailedMarker}`, classification: { status: 'phase_complete' } };
      }
      return { output: 'PHASE_COMPLETE', classification: { status: 'phase_complete' } };
    });

    await runner.stateMachineLoop(makeUnitForRun(), 'local', task, server, 'sess:1.1', defaultSignal(), 'sess:1');

    expect(calledPhaseTags(sidekickLoader).filter((phase) => phase === 'reviewing').length).toBeGreaterThan(1);
    expect(taskRepo.update).toHaveBeenCalledWith(1, { selfReviewCount: 1 });
    expect(taskRepo.updateStatus.mock.calls.at(-1)).toEqual([1, 'review']);
  });

  it('does not rollback when selfReviewCount reaches maxSelfReview', async () => {
    const { runner, sidekickLoader, workerWaiter } = makeRunner();
    let callCount = 0;
    workerWaiter.waitForWorker = vi.fn(async (...args: unknown[]) => {
      callCount++;
      const doneMarker = args[6] as string;
      if (callCount === 4) {
        const testFailedMarker = doneMarker.replace('AZITO_DONE_', 'AZITO_TEST_FAILED_');
        return { output: `test failed ${testFailedMarker}`, classification: { status: 'phase_complete' } };
      }
      return { output: 'PHASE_COMPLETE', classification: { status: 'phase_complete' } };
    });

    await runner.stateMachineLoop(makeUnitForRun({ selfReviewMaxAttempts: 1 }), 'local', task, server, 'sess:1.1', defaultSignal(), 'sess:1');

    expect(calledPhaseTags(sidekickLoader).filter((phase) => phase === 'reviewing')).toHaveLength(1);
  });
});

describe('state machine flow: self-review retry', () => {
  it('retries reviewing phase when classification is not phase_complete and selfReviewCount < max', async () => {
    const { runner, taskRepo, sidekickLoader, workerWaiter } = makeRunner();
    let callCount = 0;
    workerWaiter.waitForWorker = vi.fn(async () => {
      callCount++;
      if (callCount === 3) {
        return { output: 'needs another review', classification: { status: 'incomplete' } };
      }
      return { output: 'PHASE_COMPLETE', classification: { status: 'phase_complete' } };
    });

    await runner.stateMachineLoop(makeUnitForRun(), 'local', task, server, 'sess:1.1', defaultSignal(), 'sess:1');

    expect(calledPhaseTags(sidekickLoader).filter((phase) => phase === 'reviewing').length).toBeGreaterThan(1);
    expect(taskRepo.update).toHaveBeenCalledWith(1, { selfReviewCount: 1 });
  });

  it('advances past reviewing when selfReviewCount reaches max even if not phase_complete', async () => {
    const { runner, sidekickLoader, workerWaiter } = makeRunner();
    let callCount = 0;
    workerWaiter.waitForWorker = vi.fn(async () => {
      callCount++;
      if (callCount === 3) {
        return { output: 'needs another review', classification: { status: 'incomplete' } };
      }
      return { output: 'PHASE_COMPLETE', classification: { status: 'phase_complete' } };
    });

    await runner.stateMachineLoop(makeUnitForRun({ selfReviewMaxAttempts: 1 }), 'local', task, server, 'sess:1.1', defaultSignal(), 'sess:1');

    expect(calledPhaseTags(sidekickLoader)).toEqual(['planning', 'implementing', 'reviewing', 'testing', 'pushing']);
  });
});

describe('state machine flow: error paths', () => {
  it('sets status to failed when signal is aborted', async () => {
    const { runner, taskRepo, workerInput } = makeRunner();
    const controller = new AbortController();
    controller.abort();

    await runner.stateMachineLoop(makeUnitForRun(), 'local', task, server, 'sess:1.1', controller.signal, 'sess:1');

    expect(taskRepo.updateStatus).toHaveBeenCalledWith(1, 'failed');
    expect(workerInput.sendPrompt).not.toHaveBeenCalled();
  });

  it('sets status to failed when sendPrompt throws', async () => {
    const { runner, taskRepo, workerInput } = makeRunner();
    workerInput.sendPrompt = vi.fn(async () => {
      throw new Error('send failed');
    });

    await runner.stateMachineLoop(makeUnitForRun(), 'local', task, server, 'sess:1.1', defaultSignal(), 'sess:1');

    expect(taskRepo.updateStatus).toHaveBeenCalledWith(1, 'failed');
  });
});

describe('state machine flow: phase resume', () => {
  it('starts from the currentPhase when task.currentPhase is set', async () => {
    const { runner, sidekickLoader, workerInput } = makeRunner();

    await runner.stateMachineLoop(makeUnitForRun(), 'local', { ...task, currentPhase: 'implementing' }, server, 'sess:1.1', defaultSignal(), 'sess:1');

    expect(sidekickLoader.findDefaultForTag).not.toHaveBeenCalledWith('planning');
    expect(calledPhaseTags(sidekickLoader)[0]).toBe('implementing');
    expect(workerInput.sendPrompt).toHaveBeenCalledTimes(4);
  });

  it('falls back to next enabled phase when currentPhase is disabled', async () => {
    const { runner, sidekickLoader, workerInput } = makeRunner();
    const unit = makeUnitForRun({ phaseConfig: { implementing: { enabled: false } } });

    await runner.stateMachineLoop(unit, 'local', { ...task, currentPhase: 'implementing' }, server, 'sess:1.1', defaultSignal(), 'sess:1');

    expect(calledPhaseTags(sidekickLoader)[0]).toBe('reviewing');
    expect(workerInput.sendPrompt).toHaveBeenCalledTimes(3);
  });
});

describe('state machine flow: summary accumulation', () => {
  it('extracts and stores phase summary from output file', async () => {
    const { runner, taskRepo, workerWaiter } = makeRunner();
    let storedSummaryJson: string | null = null;
    const originalUpdate = taskRepo.update;
    taskRepo.update = vi.fn((_id: number, data: Record<string, unknown>) => {
      if (data.summaryJson !== undefined) storedSummaryJson = data.summaryJson as string;
      originalUpdate(_id, data);
    });
    taskRepo.findById = vi.fn(() => ({
      id: 1, projectId: 10, unitId: 1, serverName: 'local', title: 'Test Task',
      description: null, status: 'running', currentPhase: 'planning', planMarkdown: 'THE PLAN',
      targetBranch: null, baseBranch: null, skipPr: false, selfReviewCount: 0,
      worktreePath: null, workingDirectory: '/work',
      summaryJson: storedSummaryJson as null,
    })) as typeof taskRepo.findById;
    let phaseCallCount = 0;
    workerWaiter.readPhaseOutputFile = vi.fn(async () => {
      phaseCallCount++;
      if (phaseCallCount === 1) {
        return 'plan output\nAZITO_PHASE_SUMMARY: {"phase":"planning","status":"completed","summary":"did plan"}';
      }
      if (phaseCallCount === 2) {
        return 'impl output\nAZITO_PHASE_SUMMARY: {"phase":"implementing","status":"completed","summary":"did impl"}';
      }
      return null;
    });

    await runner.stateMachineLoop(makeUnitForRun(), 'local', task, server, 'sess:1.1', defaultSignal(), 'sess:1');

    const summaryUpdates = (taskRepo.update.mock.calls as unknown[][])
      .filter((args) => (args[1] as Record<string, unknown>).summaryJson !== undefined)
      .map((args) => JSON.parse((args[1] as Record<string, unknown>).summaryJson as string));
    expect(summaryUpdates.length).toBeGreaterThanOrEqual(2);
    expect(summaryUpdates[0].phases).toEqual([
      { phase: 'planning', status: 'completed', summary: 'did plan' },
    ]);
    expect(summaryUpdates[1].phases).toEqual([
      { phase: 'planning', status: 'completed', summary: 'did plan' },
      { phase: 'implementing', status: 'completed', summary: 'did impl' },
    ]);
  });
});
