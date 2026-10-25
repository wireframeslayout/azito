import { describe, expect, it, vi } from 'vitest';
import { WindowsDeployError, type WindowsDeployInput } from './WindowsAgentDeployer';
import { updateWindowsAgent, type WindowsUpdateDeployer } from './windowsAgentUpdate';

const INPUT = { sshHost: 'ssh', host: { home: 'C:\\Users\\dev' }, version: 'new000000000', token: 'the-token' } as unknown as WindowsDeployInput;

function make(options: { previousVersion?: string; previousWasRunning?: boolean; start?: () => Promise<void>; commit?: () => Promise<void>; prune?: WindowsUpdateDeployer['pruneOldVersions']; health?: (expected: string | undefined) => Promise<void>; rollback?: () => Promise<string> } = {}) {
  const log: string[] = [];
  const deployment = {
    commit: vi.fn(async () => { log.push('commit'); await options.commit?.(); }),
    rollback: vi.fn(async () => { log.push('rollback'); return options.rollback ? options.rollback() : 'restored the previous task definition'; }),
    previousVersion: 'previousVersion' in options ? options.previousVersion : 'old000000000',
    previousWasRunning: options.previousWasRunning ?? true,
  };
  const deployer = {
    deploy: vi.fn(async () => { log.push('deploy'); return deployment; }),
    start: vi.fn(async () => { log.push('start'); await options.start?.(); }),
    describeTask: vi.fn(async () => 'the task is not running'),
    pruneOldVersions: vi.fn(options.prune ?? (async () => { log.push('prune'); return { removed: [], failed: [] }; })),
  };
  const checkHealth = vi.fn(async (expected: string | undefined) => { log.push(`health:${expected}`); await options.health?.(expected); });
  const logger = { warn: vi.fn() };
  return { deps: { deployer: deployer as unknown as WindowsUpdateDeployer, checkHealth, logger }, deployer, deployment, checkHealth, logger, log };
}

describe('updateWindowsAgent', () => {
  it('deploys with the given input (its token), starts, checks the new version, commits, then prunes keeping the new and the previous release', async () => {
    const m = make();
    const result = await updateWindowsAgent(m.deps, INPUT, 3002, 'agent.log');

    expect(result).toEqual({ success: true, version: 'new000000000' });
    expect(m.deployer.deploy).toHaveBeenCalledWith(INPUT);
    expect(m.log).toEqual(['deploy', 'start', 'health:new000000000', 'commit', 'prune']);
    expect(m.deployer.pruneOldVersions).toHaveBeenCalledWith('ssh', INPUT.host, ['new000000000', 'old000000000']);
    expect(m.deployment.rollback).not.toHaveBeenCalled();
  });

  it('returns the deploy error as a failed transfer and starts nothing', async () => {
    const m = make();
    m.deployer.deploy.mockRejectedValue(new Error('SHA256 mismatch (nothing on the host had been changed)'));
    const result = await updateWindowsAgent(m.deps, INPUT, 3002, 'agent.log');
    expect(result).toEqual({ success: false, version: 'new000000000', error: 'Transfer failed: SHA256 mismatch (nothing on the host had been changed)' });
    expect(m.deployer.start).not.toHaveBeenCalled();
  });

  it('rolls back when the start fails, then checks that the previous version answers', async () => {
    const m = make({ start: async () => { throw new Error('schtasks /Run failed'); } });
    const result = await updateWindowsAgent(m.deps, INPUT, 3002, 'agent.log');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Start failed: schtasks /Run failed. Rolled back: restored the previous task definition. the previous agent answers again');
    expect(m.log).toEqual(['deploy', 'start', 'rollback', 'health:old000000000']);
    expect(m.deployer.pruneOldVersions).not.toHaveBeenCalled();
  });

  it('rolls back when the new agent does not answer, with the task state and the log in the error', async () => {
    const m = make({ health: async (expected) => { if (expected === 'new000000000') throw new Error('Health check timed out: ECONNREFUSED'); } });
    const result = await updateWindowsAgent(m.deps, INPUT, 3002, 'C:\\agent.log');
    expect(result.error).toContain('Health check failed: Health check timed out: ECONNREFUSED. the task is not running.');
    expect(result.error).toContain('C:\\agent.log');
    expect(result.error).toContain('the previous agent answers again');
    expect(m.deployment.commit).not.toHaveBeenCalled();
    expect(m.deployer.pruneOldVersions).not.toHaveBeenCalled();
  });

  it('puts the failure to bring the previous agent back into the error', async () => {
    const m = make({ health: async () => { throw new Error('ECONNREFUSED'); }, rollback: async () => { throw new Error('the folder is locked'); } });
    const result = await updateWindowsAgent(m.deps, INPUT, 3002, 'agent.log');
    expect(result.error).toContain('the previous install could not be restored: the folder is locked');
    expect(result.error).toContain('the previous agent does NOT answer (ECONNREFUSED)');
  });

  it('does not wait for a previous agent that was not running', async () => {
    const m = make({ previousWasRunning: false, start: async () => { throw new Error('x'); } });
    const result = await updateWindowsAgent(m.deps, INPUT, 3002, 'agent.log');
    expect(result.error).toMatch(/Rolled back: restored the previous task definition. the previous agent was not running, so it was not started$/);
    expect(result.previousAgent).toBe('not_running');
    expect(m.checkHealth).not.toHaveBeenCalled();
  });

  it('is still a success when the previous install cannot be removed, and says so', async () => {
    const m = make({ commit: async () => { throw new Error('access denied'); } });
    const result = await updateWindowsAgent(m.deps, INPUT, 3002, 'agent.log');
    expect(result.success).toBe(true);
    expect(result.warning).toContain('The previous install could not be removed (access denied)');
  });

  it('logs and reports old releases that are in use (they are tried again at the next update), and still succeeds', async () => {
    const m = make({ prune: async () => ({ removed: ['cccccccccccc'], failed: [{ version: 'aaaaaaaaaaaa', reason: 'in use' }] }) });
    const result = await updateWindowsAgent(m.deps, INPUT, 3002, 'agent.log');
    expect(result.success).toBe(true);
    expect(result.warning).toBe('Old releases left in place (tried again at the next update): aaaaaaaaaaaa (in use).');
    expect(m.logger.warn).toHaveBeenCalledWith(expect.stringContaining('aaaaaaaaaaaa (in use)'));
  });

  it('reports a clean-up that failed as a whole, and removes nothing when the previous release is not known', async () => {
    const failing = make({ prune: async () => { throw new Error('ssh dropped'); } });
    expect((await updateWindowsAgent(failing.deps, INPUT, 3002, 'agent.log')).warning).toBe('Old releases could not be removed (ssh dropped).');

    const unknown = make({ previousVersion: undefined });
    const result = await updateWindowsAgent(unknown.deps, INPUT, 3002, 'agent.log');
    expect(result.success).toBe(true);
    expect(result.warning).toContain('previous release is not known');
    expect(unknown.deployer.pruneOldVersions).not.toHaveBeenCalled();
  });

  describe('a deploy that fails after it began to change the host', () => {
    const failDeploy = (m: ReturnType<typeof make>, stopped: ConstructorParameters<typeof WindowsDeployError>[1]): void => {
      m.deployer.deploy.mockRejectedValue(new WindowsDeployError('Extracting the agent bundle failed (the previous agent was started again)', stopped));
    };

    it('checks that the previous agent answers, and returns that as a state', async () => {
      const m = make();
      failDeploy(m, { wasRunning: true, version: 'old000000000' });
      const result = await updateWindowsAgent(m.deps, INPUT, 3002, 'agent.log');
      expect(result).toMatchObject({ success: false, previousAgent: 'answers' });
      expect(result.error).toContain('Transfer failed: Extracting the agent bundle failed');
      expect(result.error).toContain('the previous agent answers again');
      expect(m.checkHealth).toHaveBeenCalledWith('old000000000');
    });

    it('says the previous agent does not answer when it started and exited again', async () => {
      const m = make({ health: async () => { throw new Error('ECONNREFUSED'); } });
      failDeploy(m, { wasRunning: true, version: 'old000000000' });
      const result = await updateWindowsAgent(m.deps, INPUT, 3002, 'agent.log');
      expect(result.previousAgent).toBe('not_answering');
      expect(result.error).toContain('the previous agent does NOT answer (ECONNREFUSED)');
    });

    it('does not look at health when the previous agent was not running, nor when nothing on the host had been touched', async () => {
      const stopped = make();
      failDeploy(stopped, { wasRunning: false, version: undefined });
      expect((await updateWindowsAgent(stopped.deps, INPUT, 3002, 'agent.log')).previousAgent).toBe('not_running');
      expect(stopped.checkHealth).not.toHaveBeenCalled();

      const untouched = make();
      failDeploy(untouched, undefined);
      const result = await updateWindowsAgent(untouched.deps, INPUT, 3002, 'agent.log');
      expect(result.previousAgent).toBeUndefined();
      expect(untouched.checkHealth).not.toHaveBeenCalled();
    });
  });

  it('logs a failed commit (a *.prev that blocks the next update) itself', async () => {
    const m = make({ commit: async () => { throw new Error('access denied'); } });
    await updateWindowsAgent(m.deps, INPUT, 3002, 'agent.log');
    expect(m.logger.warn).toHaveBeenCalledWith(expect.stringContaining('access denied'));
  });
});
