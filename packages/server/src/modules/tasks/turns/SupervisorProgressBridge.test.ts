import { describe, it, expect, vi } from 'vitest';
import { bridgeSupervisorActivityToProgress } from './SupervisorProgressBridge';
import type { AgentTurn } from './AgentTurn';

function makeTurn(overrides: Partial<AgentTurn> = {}): AgentTurn {
  return {
    id: 42,
    taskId: 10,
    unitId: null,
    kind: 'phase',
    phase: 'implementing',
    nonce: 'n1',
    status: 'running',
    completionSource: null,
    confidence: null,
    serverName: null,
    tmuxTarget: null,
    outputFilePath: null,
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: null,
    ...overrides,
  };
}

describe('bridgeSupervisorActivityToProgress', () => {
  it('emits a progress signal for the running turn when the event is active', () => {
    const findRunningByTask = vi.fn().mockReturnValue(makeTurn({ id: 42 }));
    const emitSignal = vi.fn();

    bridgeSupervisorActivityToProgress(
      { taskId: 10, state: 'active' },
      { agentTurnRepo: { findRunningByTask }, turnSignalHub: { emitSignal } },
    );

    expect(findRunningByTask).toHaveBeenCalledWith(10);
    expect(emitSignal).toHaveBeenCalledWith(42, { type: 'progress' });
  });

  it('does nothing when the event is idle', () => {
    const findRunningByTask = vi.fn().mockReturnValue(makeTurn());
    const emitSignal = vi.fn();

    bridgeSupervisorActivityToProgress(
      { taskId: 10, state: 'idle' },
      { agentTurnRepo: { findRunningByTask }, turnSignalHub: { emitSignal } },
    );

    expect(findRunningByTask).not.toHaveBeenCalled();
    expect(emitSignal).not.toHaveBeenCalled();
  });

  it('does nothing when the event has no taskId', () => {
    const findRunningByTask = vi.fn().mockReturnValue(makeTurn());
    const emitSignal = vi.fn();

    bridgeSupervisorActivityToProgress(
      { taskId: null, state: 'active' },
      { agentTurnRepo: { findRunningByTask }, turnSignalHub: { emitSignal } },
    );

    expect(findRunningByTask).not.toHaveBeenCalled();
    expect(emitSignal).not.toHaveBeenCalled();
  });

  it('does nothing when no turn is currently running for the task', () => {
    const findRunningByTask = vi.fn().mockReturnValue(null);
    const emitSignal = vi.fn();

    bridgeSupervisorActivityToProgress(
      { taskId: 10, state: 'active' },
      { agentTurnRepo: { findRunningByTask }, turnSignalHub: { emitSignal } },
    );

    expect(findRunningByTask).toHaveBeenCalledWith(10);
    expect(emitSignal).not.toHaveBeenCalled();
  });
});
