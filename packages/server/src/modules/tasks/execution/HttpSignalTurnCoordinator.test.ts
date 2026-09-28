import { describe, it, expect, vi } from 'vitest';
import { HttpSignalTurnCoordinator } from './HttpSignalTurnCoordinator';
import type { AgentTurn } from '../turns/AgentTurn';

function makeTurn(overrides: Partial<AgentTurn> = {}): AgentTurn {
  return {
    id: 1,
    taskId: 1,
    unitId: 1,
    kind: 'phase',
    phase: 'implementing',
    nonce: 'abc123',
    status: 'running',
    completionSource: null,
    confidence: null,
    serverName: 'local',
    tmuxTarget: 'sess:1.1',
    outputFilePath: '/tmp/azito-output-1-abc123.md',
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: null,
    ...overrides,
  };
}

function makeCoordinator(overrides: { turnRepo?: Record<string, unknown> } = {}) {
  const turn = makeTurn();
  const turnRepo = {
    supersedeRunning: vi.fn(),
    create: vi.fn(() => turn),
    findById: vi.fn(() => turn),
    markEnded: vi.fn(),
    appendEvent: vi.fn(),
    findLatestEventByType: vi.fn(() => null),
    ...overrides.turnRepo,
  };
  const turnSignalHub = { subscribe: vi.fn(() => () => {}), emitSignal: vi.fn() };
  const coordinator = new HttpSignalTurnCoordinator(turnRepo as any, turnSignalHub as any);
  return { coordinator, turnRepo, turnSignalHub, turn };
}

const server = { name: 'local', type: 'local' as const, host: null, agentPort: null, agentToken: null, agentVersion: null, sshHost: null, sshHostFingerprint: null, muxRuntime: 'system' as const, isolationIntent: false, isolationVerifiedAt: null, isolationReport: null, isolationCleanupReport: null, createdAt: '2026-01-01T00:00:00Z' };

describe('HttpSignalTurnCoordinator.start', () => {
  it('supersedes running turns, creates a new one, starts its signal stream, and wraps the prompt', () => {
    const { coordinator, turnRepo } = makeCoordinator();

    const result = coordinator.start({
      taskId: 1, unitId: 1, kind: 'phase', phase: 'implementing', capability: { questions: true, testFailed: false }, nonce: 'abc123',
      server, target: 'sess:1.1', prompt: 'Implement the feature.', outputFilePath: '/tmp/out.md',
    });

    expect(turnRepo.supersedeRunning).toHaveBeenCalledWith(1);
    expect(turnRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 1, unitId: 1, kind: 'phase', phase: 'implementing', nonce: 'abc123',
      serverName: 'local', tmuxTarget: 'sess:1.1', outputFilePath: '/tmp/out.md',
    }));
    expect(result.turn.id).toBe(1);
    expect(result.markerizedPrompt).toContain('Implement the feature.');
    expect(result.markerizedPrompt).toContain('completion_signal');
    expect(result.markerizedPrompt).toContain('1.1.abc123');
  });
});

describe('HttpSignalTurnCoordinator.finalize', () => {
  it('returns null turn and passes classification through when the turn no longer exists', async () => {
    const { coordinator } = makeCoordinator({ turnRepo: { findById: vi.fn(() => null) } });

    const result = await coordinator.finalize(999, { status: 'phase_complete' }, false);

    expect(result.turn).toBeNull();
    expect(result.classification).toEqual({ status: 'phase_complete' });
  });

  it('overrides classification to stopped when the turn was explicitly reported failed', async () => {
    const { coordinator } = makeCoordinator({
      turnRepo: { findById: vi.fn(() => makeTurn({ status: 'failed' })) },
    });

    const result = await coordinator.finalize(1, { status: 'phase_complete' }, false);

    expect(result.classification).toEqual({ status: 'stopped' });
    expect(result.turn?.status).toBe('failed');
  });

  it('overrides classification to phase_complete when the turn was explicitly reported test_failed', async () => {
    const { coordinator } = makeCoordinator({
      turnRepo: { findById: vi.fn(() => makeTurn({ status: 'test_failed' })) },
    });

    const result = await coordinator.finalize(1, { status: 'stopped' }, false);

    expect(result.classification).toEqual({ status: 'phase_complete' });
  });

  it('preserves the parsed question classification when the turn was explicitly reported questions', async () => {
    const { coordinator } = makeCoordinator({
      turnRepo: { findById: vi.fn(() => makeTurn({ status: 'questions' })) },
    });
    const withQuestions = { status: 'question' as const, questions: [{ text: 'Which branch?', type: 'text' as const }] };

    const result = await coordinator.finalize(1, withQuestions, false);

    expect(result.classification).toEqual(withQuestions);
  });

  it('recovers the questions array from the turn\'s "questions" event payload when the wait classification is not a question', async () => {
    // e.g. the wait settled via timeout/classifier while the azitoctl questions
    // signal had already landed — classification alone would lose the questions.
    const questions = [{ text: 'Which branch?', type: 'select', options: ['main', 'develop'] }];
    const { coordinator } = makeCoordinator({
      turnRepo: {
        findById: vi.fn(() => makeTurn({ status: 'questions' })),
        findLatestEventByType: vi.fn(() => ({
          id: 1, turnId: 1, type: 'questions', source: 'http', createdAt: '2026-01-01T00:00:00Z',
          payload: JSON.stringify({ turnToken: '1.1.abc123', type: 'questions', questions }),
        })),
      },
    });

    const result = await coordinator.finalize(1, { status: 'stopped' }, false);

    expect(result.classification).toEqual({ status: 'question', questions });
  });

  it('recovers the questions array from the event payload when the wait classification is a question with no questions', async () => {
    const questions = [{ text: 'Proceed?', type: 'text' }];
    const { coordinator } = makeCoordinator({
      turnRepo: {
        findById: vi.fn(() => makeTurn({ status: 'questions' })),
        findLatestEventByType: vi.fn(() => ({
          id: 1, turnId: 1, type: 'questions', source: 'http', createdAt: '2026-01-01T00:00:00Z',
          payload: JSON.stringify({ turnToken: '1.1.abc123', type: 'questions', questions }),
        })),
      },
    });

    const result = await coordinator.finalize(1, { status: 'question' }, false);

    expect(result.classification).toEqual({ status: 'question', questions });
  });

  it('falls back to a bare question classification when no questions event payload is recoverable', async () => {
    const { coordinator, turnRepo } = makeCoordinator({
      turnRepo: { findById: vi.fn(() => makeTurn({ status: 'questions' })) },
    });

    const result = await coordinator.finalize(1, { status: 'stopped' }, false);

    expect(turnRepo.findLatestEventByType).toHaveBeenCalledWith(1, 'questions');
    expect(result.classification).toEqual({ status: 'question' });
  });

  it('does not call markEnded/appendEvent again when the turn already has a terminal status', async () => {
    const { coordinator, turnRepo } = makeCoordinator({
      turnRepo: { findById: vi.fn(() => makeTurn({ status: 'completed' })) },
    });

    await coordinator.finalize(1, { status: 'phase_complete' }, false);

    expect(turnRepo.markEnded).not.toHaveBeenCalled();
    expect(turnRepo.appendEvent).not.toHaveBeenCalled();
  });

  it('marks the turn aborted (inferred, source abort) when still running and the signal was aborted', async () => {
    const runningTurn = makeTurn({ status: 'running' });
    const endedTurn = makeTurn({ status: 'aborted' });
    let called = false;
    const { coordinator, turnRepo } = makeCoordinator({
      turnRepo: {
        findById: vi.fn(() => {
          const result = called ? endedTurn : runningTurn;
          called = true;
          return result;
        }),
      },
    });

    const result = await coordinator.finalize(1, { status: 'stopped' }, true);

    expect(turnRepo.markEnded).toHaveBeenCalledWith(1, { status: 'aborted', completionSource: 'abort', confidence: 'inferred' });
    expect(turnRepo.appendEvent).toHaveBeenCalledWith(1, { type: 'aborted', source: 'internal' });
    expect(result.turn?.status).toBe('aborted');
  });

  it('infers completed (classifier, inferred) when still running and the wait resolved via classifier/probe/timeout', async () => {
    const { coordinator, turnRepo } = makeCoordinator({
      turnRepo: { findById: vi.fn(() => makeTurn({ status: 'running' })) },
    });

    await coordinator.finalize(1, { status: 'phase_complete' }, false);

    expect(turnRepo.markEnded).toHaveBeenCalledWith(1, { status: 'completed', completionSource: 'classifier', confidence: 'inferred' });
  });

  it('infers failed when still running and the wait resolved as stopped', async () => {
    const { coordinator, turnRepo } = makeCoordinator({
      turnRepo: { findById: vi.fn(() => makeTurn({ status: 'running' })) },
    });

    await coordinator.finalize(1, { status: 'stopped' }, false);

    expect(turnRepo.markEnded).toHaveBeenCalledWith(1, { status: 'failed', completionSource: 'classifier', confidence: 'inferred' });
  });
});

describe('HttpSignalTurnCoordinator.rejectInferredCompletion', () => {
  it('re-marks the turn failed and records an internal failed event with the rejection reason', () => {
    const { coordinator, turnRepo } = makeCoordinator();

    coordinator.rejectInferredCompletion(1);

    expect(turnRepo.markEnded).toHaveBeenCalledWith(1, { status: 'failed', completionSource: 'classifier', confidence: 'inferred' });
    expect(turnRepo.appendEvent).toHaveBeenCalledWith(1, {
      type: 'failed',
      payload: JSON.stringify({ reason: 'phase_complete_without_output_rejected' }),
      source: 'internal',
    });
  });
});

describe('HttpSignalTurnCoordinator.readOutput', () => {
  it('returns the output field from the latest "complete" event payload', () => {
    const { coordinator, turnRepo } = makeCoordinator({
      turnRepo: { findLatestEventByType: vi.fn(() => ({ id: 1, turnId: 1, type: 'complete', payload: '{"output":"the plan"}', source: 'http', createdAt: '2026-01-01T00:00:00Z' })) },
    });

    expect(coordinator.readOutput(1)).toBe('the plan');
    expect(turnRepo.findLatestEventByType).toHaveBeenCalledWith(1, 'complete');
  });

  it('returns null when there is no complete event', () => {
    const { coordinator } = makeCoordinator();
    expect(coordinator.readOutput(1)).toBeNull();
  });

  it('returns null when the payload has no output field', () => {
    const { coordinator } = makeCoordinator({
      turnRepo: { findLatestEventByType: vi.fn(() => ({ id: 1, turnId: 1, type: 'complete', payload: '{"summary":"x"}', source: 'http', createdAt: '2026-01-01T00:00:00Z' })) },
    });

    expect(coordinator.readOutput(1)).toBeNull();
  });

  it('returns null when the payload is invalid JSON', () => {
    const { coordinator } = makeCoordinator({
      turnRepo: { findLatestEventByType: vi.fn(() => ({ id: 1, turnId: 1, type: 'complete', payload: 'not json', source: 'http', createdAt: '2026-01-01T00:00:00Z' })) },
    });

    expect(coordinator.readOutput(1)).toBeNull();
  });
});
