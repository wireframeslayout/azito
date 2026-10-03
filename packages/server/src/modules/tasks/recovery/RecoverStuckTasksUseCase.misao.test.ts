import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import { RecoverStuckTasksUseCase } from './RecoverStuckTasksUseCase';
import { MuxDriverRegistry } from '../../tmux/MuxDriverRegistry';
import type { IMuxClient } from '../../tmux/IMuxClient';
import type { ServerConfig } from '../../servers/Server';
import { MuxDriverUnavailableError } from '../../tmux/MuxCapabilityError';

vi.mock('fs');

const devopsType = {
  name: 'devops', label: 'DevOps', description: '',
  phases: [{ name: 'implementing', label: 'Implementing', tags: ['implementing'], questions: true, testFailed: false, planApproval: false, selfReviewRetry: false, pushVerify: false, skillCommand: 'azt-implement' }],
};

function task(id: number, serverName: string) {
  return { id, projectId: 1, unitId: 1, serverName, status: 'running', currentPhase: 'implementing', tmuxWindow: `task-${id}`, updatedAt: '2026-06-16T00:00:00Z' };
}

describe('RecoverStuckTasksUseCase with a misao server whose driver is unavailable', () => {
  it('skips only the misao task and still recovers the tmux task', async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([]);
    vi.mocked(fs.readFileSync).mockReturnValue('');
    const servers: Record<string, ServerConfig> = {
      'misao-server': { name: 'misao-server', type: 'local', muxRuntime: 'misao' } as ServerConfig,
      'tmux-server': { name: 'tmux-server', type: 'local', muxRuntime: 'system' } as ServerConfig,
    };
    const tmuxDriver = {
      kind: 'tmux',
      resolvePane: vi.fn().mockResolvedValue('%0'),
      probePane: vi.fn().mockResolvedValue({ alive: true, verified: true }),
      sendKeysToHandle: vi.fn().mockResolvedValue(undefined),
    } as unknown as IMuxClient;
    const registry = new MuxDriverRegistry({ misaoEnabled: false });
    registry.register('tmux', tmuxDriver);
    const resumeStateMachine = vi.fn().mockResolvedValue(undefined);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const tasks = [task(20, 'misao-server'), task(21, 'tmux-server')];

    const useCase = new RecoverStuckTasksUseCase(
      { findByStatus: vi.fn((status: string) => (status === 'running' ? tasks : [])), updateStatus: vi.fn(), updateCurrentPhase: vi.fn() } as never,
      { findById: vi.fn().mockReturnValue({ id: 1, workerExecutionMode: 'tmux-pipe', unitType: 'devops' }) } as never,
      { findByName: (name: string) => servers[name] ?? null } as never,
      { findById: vi.fn().mockReturnValue({ id: 1, defaultUnitId: null }) } as never,
      { find: vi.fn().mockReturnValue(null), findByProject: vi.fn().mockReturnValue([]) } as never,
      { findByTask: vi.fn().mockReturnValue([]), append: vi.fn() } as never,
      registry,
      { getRunning: vi.fn().mockReturnValue({}), resumeStateMachine, isPushCompleted: vi.fn().mockResolvedValue(false) } as never,
      { findLatestByTaskPhase: vi.fn().mockReturnValue(null), supersedeRunning: vi.fn(), findLatestEventByType: vi.fn().mockReturnValue(null) } as never,
      logger,
      { getOrThrow: vi.fn(() => devopsType), get: vi.fn(() => devopsType) } as never,
      { findByTask: vi.fn().mockReturnValue([]) } as never,
    );

    await expect(useCase.run()).resolves.toBeUndefined();

    expect(resumeStateMachine).toHaveBeenCalledTimes(1);
    expect(resumeStateMachine).toHaveBeenCalledWith(1, 21);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('task 20'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('misao_disabled'));
  });
});

describe('RecoverStuckTasksUseCase with a connected misao driver', () => {
  const WINDOW_ID = 'w_01M3XFD8H97JCPKS5Y5BH3JZQH';

  function build(taskRow: Record<string, unknown>, windows: unknown[]) {
    vi.mocked(fs.readdirSync).mockReturnValue([]);
    vi.mocked(fs.readFileSync).mockReturnValue('');
    const misaoDriver = {
      kind: 'misao',
      resolvePane: vi.fn().mockResolvedValue('p_01M3XFD8H97JCPKS5Y5BH3JZQH'),
      probePane: vi.fn().mockResolvedValue({ alive: true, verified: true }),
      sendKeysToHandle: vi.fn().mockResolvedValue(undefined),
    };
    const registry = new MuxDriverRegistry({ misaoEnabled: true });
    registry.register('misao', misaoDriver as unknown as IMuxClient);
    const resumeStateMachine = vi.fn().mockResolvedValue(undefined);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const useCase = new RecoverStuckTasksUseCase(
      { findByStatus: vi.fn((status: string) => (status === 'running' ? [taskRow] : [])), updateStatus: vi.fn(), updateCurrentPhase: vi.fn() } as never,
      { findById: vi.fn().mockReturnValue({ id: 1, workerExecutionMode: 'tmux-pipe', unitType: 'devops' }) } as never,
      { findByName: () => ({ name: 'misao-server', type: 'local', muxRuntime: 'misao' }) } as never,
      { findById: vi.fn().mockReturnValue({ id: 1, defaultUnitId: null }) } as never,
      { find: vi.fn().mockReturnValue(null), findByProject: vi.fn().mockReturnValue([]) } as never,
      { findByTask: vi.fn().mockReturnValue([]), append: vi.fn() } as never,
      registry,
      { getRunning: vi.fn().mockReturnValue({}), resumeStateMachine, isPushCompleted: vi.fn().mockResolvedValue(false) } as never,
      { findLatestByTaskPhase: vi.fn().mockReturnValue(null), supersedeRunning: vi.fn(), findLatestEventByType: vi.fn().mockReturnValue(null) } as never,
      logger,
      { getOrThrow: vi.fn(() => devopsType), get: vi.fn(() => devopsType) } as never,
      { findByTask: vi.fn().mockReturnValue(windows) } as never,
    );
    return { useCase, misaoDriver, resumeStateMachine, logger };
  }

  it('resolves the pane from the primary window row\'s window id, not from a display name left in task.tmuxWindow', async () => {
    const row = { isPrimary: true, ownerType: 'task', tmuxTarget: `azito:${WINDOW_ID}`, muxRef: { kind: 'misao', workspace: 'azito', window: WINDOW_ID } };
    const { useCase, misaoDriver, resumeStateMachine } = build({ ...task(30, 'misao-server'), tmuxWindow: 'task-30--ab12' }, [row]);

    await useCase.run();

    expect(misaoDriver.resolvePane).toHaveBeenCalledWith(expect.anything(), { kind: 'misao', workspace: 'azito', window: WINDOW_ID }, 1);
    expect(resumeStateMachine).toHaveBeenCalledWith(1, 30);
  });

  it('falls back to task.tmuxWindow (a window id) when the task has no window row', async () => {
    const { useCase, misaoDriver, resumeStateMachine } = build({ ...task(31, 'misao-server'), tmuxWindow: WINDOW_ID }, []);

    await useCase.run();

    expect(misaoDriver.resolvePane).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: 'misao', window: WINDOW_ID }), 1);
    expect(resumeStateMachine).toHaveBeenCalledWith(1, 31);
  });
});

describe('RecoverStuckTasksUseCase.runSkippedForDaemon', () => {
  const WINDOW_ID = 'w_01M3XFD8H97JCPKS5Y5BH3JZQH';

  it('after the daemon connects, recovers only the misao task the first run skipped and never resumes an already-resumed task again', async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([]);
    vi.mocked(fs.readFileSync).mockReturnValue('');
    const servers: Record<string, ServerConfig> = {
      'misao-server': { name: 'misao-server', type: 'local', muxRuntime: 'misao' } as ServerConfig,
      'tmux-server': { name: 'tmux-server', type: 'local', muxRuntime: 'system' } as ServerConfig,
    };
    const driverOf = (kind: string) => ({
      kind,
      resolvePane: vi.fn().mockResolvedValue('%0'),
      probePane: vi.fn().mockResolvedValue({ alive: true, verified: true }),
      sendKeysToHandle: vi.fn().mockResolvedValue(undefined),
    });
    const tmuxDriver = driverOf('tmux');
    const misaoDriver = driverOf('misao');
    let daemonUp = false;
    const registry = new MuxDriverRegistry({ misaoEnabled: true });
    registry.register('tmux', tmuxDriver as unknown as IMuxClient);
    registry.register('misao', misaoDriver as unknown as IMuxClient, () => (daemonUp ? { available: true } : { available: false, reason: 'daemon_unreachable' }));
    const resumeStateMachine = vi.fn().mockResolvedValue(undefined);
    const tasks = [
      { ...task(40, 'misao-server'), tmuxWindow: WINDOW_ID },
      task(41, 'tmux-server'),
    ];
    const useCase = new RecoverStuckTasksUseCase(
      { findByStatus: vi.fn((status: string) => (status === 'running' ? tasks : [])), updateStatus: vi.fn(), updateCurrentPhase: vi.fn() } as never,
      { findById: vi.fn().mockReturnValue({ id: 1, workerExecutionMode: 'tmux-pipe', unitType: 'devops' }) } as never,
      { findByName: (name: string) => servers[name] ?? null } as never,
      { findById: vi.fn().mockReturnValue({ id: 1, defaultUnitId: null }) } as never,
      { find: vi.fn().mockReturnValue(null), findByProject: vi.fn().mockReturnValue([]) } as never,
      { findByTask: vi.fn().mockReturnValue([]), append: vi.fn() } as never,
      registry,
      // resumeStateMachine registers the run only after it awaits, so a second full run would pick the tmux task again
      { getRunning: vi.fn().mockReturnValue({}), resumeStateMachine, isPushCompleted: vi.fn().mockResolvedValue(false) } as never,
      { findLatestByTaskPhase: vi.fn().mockReturnValue(null), supersedeRunning: vi.fn(), findLatestEventByType: vi.fn().mockReturnValue(null) } as never,
      { info: vi.fn(), warn: vi.fn() },
      { getOrThrow: vi.fn(() => devopsType), get: vi.fn(() => devopsType) } as never,
      { findByTask: vi.fn().mockReturnValue([]) } as never,
    );

    await useCase.run();
    expect(resumeStateMachine.mock.calls).toEqual([[1, 41]]);
    expect(tmuxDriver.sendKeysToHandle).toHaveBeenCalledTimes(1);

    daemonUp = true;
    await useCase.runSkippedForDaemon();

    expect(resumeStateMachine.mock.calls).toEqual([[1, 41], [1, 40]]);
    expect(tmuxDriver.sendKeysToHandle).toHaveBeenCalledTimes(1);
    expect(misaoDriver.resolvePane).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: 'misao', window: WINDOW_ID }), 1);

    await useCase.runSkippedForDaemon();
    expect(resumeStateMachine).toHaveBeenCalledTimes(2);
  });
});

describe('RecoverStuckTasksUseCase keeps a task pending while the daemon keeps dropping', () => {
  const WINDOW_ID = 'w_01M3XFD8H97JCPKS5Y5BH3JZQH';

  it('a daemon loss during resolvePane / probePane defers the task (not "pane dead"), retried on each connection until handled', async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([]);
    vi.mocked(fs.readFileSync).mockReturnValue('');
    const down = () => new MuxDriverUnavailableError('misao', 'daemon_unreachable');
    const misaoDriver = {
      kind: 'misao',
      resolvePane: vi.fn().mockRejectedValueOnce(down()).mockResolvedValue('p_01M3XFD8H97JCPKS5Y5BH3JZQH'),
      probePane: vi.fn().mockRejectedValueOnce(down()).mockResolvedValue({ alive: true, verified: true }),
      sendKeysToHandle: vi.fn().mockResolvedValue(undefined),
    };
    const registry = new MuxDriverRegistry({ misaoEnabled: true });
    registry.register('misao', misaoDriver as unknown as IMuxClient);
    const resumeStateMachine = vi.fn().mockResolvedValue(undefined);
    const logger = { info: vi.fn(), warn: vi.fn() };
    const useCase = new RecoverStuckTasksUseCase(
      { findByStatus: vi.fn((status: string) => (status === 'running' ? [{ ...task(50, 'misao-server'), tmuxWindow: WINDOW_ID }] : [])), updateStatus: vi.fn(), updateCurrentPhase: vi.fn() } as never,
      { findById: vi.fn().mockReturnValue({ id: 1, workerExecutionMode: 'tmux-pipe', unitType: 'devops' }) } as never,
      { findByName: () => ({ name: 'misao-server', type: 'local', muxRuntime: 'misao' }) } as never,
      { findById: vi.fn().mockReturnValue({ id: 1, defaultUnitId: null }) } as never,
      { find: vi.fn().mockReturnValue(null), findByProject: vi.fn().mockReturnValue([]) } as never,
      { findByTask: vi.fn().mockReturnValue([]), append: vi.fn() } as never,
      registry,
      { getRunning: vi.fn().mockReturnValue({}), resumeStateMachine, isPushCompleted: vi.fn().mockResolvedValue(false) } as never,
      { findLatestByTaskPhase: vi.fn().mockReturnValue(null), supersedeRunning: vi.fn(), findLatestEventByType: vi.fn().mockReturnValue(null) } as never,
      logger,
      { getOrThrow: vi.fn(() => devopsType), get: vi.fn(() => devopsType) } as never,
      { findByTask: vi.fn().mockReturnValue([]) } as never,
    );

    await useCase.run();
    expect(useCase.hasPendingForDaemon()).toBe(true); // resolvePane dropped
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('pane dead'));

    await useCase.runSkippedForDaemon();
    expect(useCase.hasPendingForDaemon()).toBe(true); // probePane dropped
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('probe'));
    expect(resumeStateMachine).not.toHaveBeenCalled();

    await useCase.runSkippedForDaemon();
    expect(useCase.hasPendingForDaemon()).toBe(false);
    expect(resumeStateMachine).toHaveBeenCalledWith(1, 50);
  });
});
