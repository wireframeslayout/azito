import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import { RecoverStuckTasksUseCase } from './RecoverStuckTasksUseCase';
import { MuxDriverRegistry } from '../../tmux/MuxDriverRegistry';
import type { IMuxClient } from '../../tmux/IMuxClient';
import type { ServerConfig } from '../../servers/Server';

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
    );

    await expect(useCase.run()).resolves.toBeUndefined();

    expect(resumeStateMachine).toHaveBeenCalledTimes(1);
    expect(resumeStateMachine).toHaveBeenCalledWith(1, 21);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('task 20'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('misao_disabled'));
  });
});
