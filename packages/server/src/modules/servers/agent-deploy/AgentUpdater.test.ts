import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentUpdater } from './AgentUpdater';
import type { ServerConfig } from '../Server';

function makeServer(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    name: 'test-server',
    type: 'agent',
    host: '100.64.0.1',
    agentPort: 3002,
    agentToken: 'tok123',
    agentVersion: 'abc1234',
    sshHost: 'user@remote',
    sshHostFingerprint: null,
    isolationIntent: false,
    isolationVerifiedAt: null,
    isolationReport: null,
    muxRuntime: 'system',
    createdAt: '2024-01-01',
    ...overrides,
  };
}

function makeMocks(bundleHash = 'abc1234') {
  const bundler = {
    getHubSha: vi.fn(() => bundleHash),
    getBundledSha: vi.fn(() => bundleHash),
    getTarballPath: vi.fn(() => '/tmp/fake.tar.gz'),
    getBundleHash: vi.fn(() => bundleHash),
    needsBuild: vi.fn(() => false),
    ensureBuild: vi.fn(),
  };
  const installer = {
    install: vi.fn(),
    update: vi.fn(),
    recoverAgent: vi.fn(() => Promise.resolve('systemd' as const)),
  };
  const serverRepo = {
    findAll: vi.fn((): ServerConfig[] => []),
    findByName: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateAgentVersion: vi.fn(),
    updateFingerprint: vi.fn(),
    clearFingerprint: vi.fn(),
    delete: vi.fn(),
  };
  const taskRepo = {
    findAll: vi.fn((): Array<{ id: number; status: string; unitId: number; serverName: string | null }> => []),
    findById: vi.fn(),
    findByProject: vi.fn((): Array<{ id: number; status: string; unitId: number; serverName: string | null }> => []),
    findByUnit: vi.fn((): Array<{ id: number; status: string; unitId: number; serverName: string | null }> => []),
    findByStatus: vi.fn((): Array<{ id: number; status: string; unitId: number; serverName: string | null }> => []),
    create: vi.fn(),
    update: vi.fn(),
    updateStatus: vi.fn(),
    delete: vi.fn(),
  };

  return { bundler, installer, serverRepo, taskRepo };
}

describe('AgentUpdater', () => {
  it('returns up_to_date for non-agent servers', async () => {
    const mocks = makeMocks();
    const updater = new AgentUpdater(
      mocks.bundler as any, mocks.installer as any,
      mocks.serverRepo as any, mocks.taskRepo as any,
    );

    const result = await updater.checkAndUpdate(makeServer({ type: 'local' }));
    expect(result.status).toBe('up_to_date');
  });

  it('returns up_to_date for agent without host', async () => {
    const mocks = makeMocks();
    const updater = new AgentUpdater(
      mocks.bundler as any, mocks.installer as any,
      mocks.serverRepo as any, mocks.taskRepo as any,
    );

    const result = await updater.checkAndUpdate(makeServer({ host: null }));
    expect(result.status).toBe('up_to_date');
  });

  it('returns error when agent is unreachable and no sshHost is configured for recovery', async () => {
    const mocks = makeMocks('new-sha');
    const updater = new AgentUpdater(
      mocks.bundler as any, mocks.installer as any,
      mocks.serverRepo as any, mocks.taskRepo as any,
    );

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))));

    const result = await updater.checkAndUpdate(makeServer({ sshHost: null }));
    expect(result.status).toBe('error');
    expect(result.message).toContain('unreachable');
    expect(mocks.installer.recoverAgent).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('recovers an unreachable agent via SSH and continues the normal flow', async () => {
    vi.useFakeTimers();
    const sha = 'abc1234';
    const mocks = makeMocks(sha);
    const updater = new AgentUpdater(
      mocks.bundler as any, mocks.installer as any,
      mocks.serverRepo as any, mocks.taskRepo as any,
    );

    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('ECONNREFUSED'));
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ version: sha }) });
    }));

    const resultPromise = updater.checkAndUpdate(makeServer());
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(mocks.installer.recoverAgent).toHaveBeenCalledWith('user@remote', '100.64.0.1', 'tok123', 'system');
    expect(result.status).toBe('up_to_date');
    expect(result.currentVersion).toBe(sha);

    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('returns error when SSH recovery also fails to bring the agent back', async () => {
    vi.useFakeTimers();
    const mocks = makeMocks('new-sha');
    const updater = new AgentUpdater(
      mocks.bundler as any, mocks.installer as any,
      mocks.serverRepo as any, mocks.taskRepo as any,
    );

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))));

    const resultPromise = updater.checkAndUpdate(makeServer());
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(mocks.installer.recoverAgent).toHaveBeenCalledWith('user@remote', '100.64.0.1', 'tok123', 'system');
    expect(result.status).toBe('error');
    expect(result.message).toContain('unreachable');
    expect(result.message).toContain('SSH 経由の復旧も失敗');

    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('still re-checks health and reports error when recoverAgent itself throws', async () => {
    vi.useFakeTimers();
    const mocks = makeMocks('new-sha');
    mocks.installer.recoverAgent.mockRejectedValue(new Error('SSH connect failed'));

    const updater = new AgentUpdater(
      mocks.bundler as any, mocks.installer as any,
      mocks.serverRepo as any, mocks.taskRepo as any,
    );

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))));

    const resultPromise = updater.checkAndUpdate(makeServer());
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(mocks.installer.recoverAgent).toHaveBeenCalledWith('user@remote', '100.64.0.1', 'tok123', 'system');
    expect(result.status).toBe('error');
    expect(result.message).toContain('SSH 経由の復旧も失敗');

    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('returns up_to_date when versions match', async () => {
    const sha = 'abc1234';
    const mocks = makeMocks(sha);
    const updater = new AgentUpdater(
      mocks.bundler as any, mocks.installer as any,
      mocks.serverRepo as any, mocks.taskRepo as any,
    );

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ version: sha }),
    })));

    const result = await updater.checkAndUpdate(makeServer());
    expect(result.status).toBe('up_to_date');
    expect(result.currentVersion).toBe(sha);
    expect(mocks.bundler.ensureBuild).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('returns error (not throw) when the local bundle is unavailable', async () => {
    const mocks = makeMocks();
    mocks.bundler.getBundleHash.mockImplementation(() => {
      throw new Error('ENOENT: bundle-hash.txt not found');
    });

    const updater = new AgentUpdater(
      mocks.bundler as any, mocks.installer as any,
      mocks.serverRepo as any, mocks.taskRepo as any,
    );

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ version: 'remote-version' }),
    })));

    const result = await updater.checkAndUpdate(makeServer());
    expect(result.status).toBe('error');
    expect(result.message).toContain('Local agent bundle unavailable');
    expect(result.currentVersion).toBe('remote-version');
    expect(mocks.installer.update).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('compares against the bundle content hash, not the hub git SHA', async () => {
    // A hub-only (e.g. frontend) commit changes getHubSha() but leaves the bundle
    // content hash unchanged — the agent must not be flagged for update in that case.
    const mocks = makeMocks('stable-bundle-hash');
    mocks.bundler.getHubSha.mockReturnValue('new-git-sha-unrelated-to-agent');

    const updater = new AgentUpdater(
      mocks.bundler as any, mocks.installer as any,
      mocks.serverRepo as any, mocks.taskRepo as any,
    );

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ version: 'stable-bundle-hash' }),
    })));

    const result = await updater.checkAndUpdate(makeServer());
    expect(result.status).toBe('up_to_date');
    expect(mocks.installer.update).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('defers update when running tasks exist on the server', async () => {
    const mocks = makeMocks('new-sha');
    mocks.taskRepo.findAll.mockReturnValue([
      { id: 1, status: 'running', unitId: 1, serverName: 'test-server' },
    ]);

    const updater = new AgentUpdater(
      mocks.bundler as any, mocks.installer as any,
      mocks.serverRepo as any, mocks.taskRepo as any,
    );

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ version: 'old-sha' }),
    })));

    const result = await updater.checkAndUpdate(makeServer());
    expect(result.status).toBe('deferred');
    expect(result.message).toContain('running tasks');

    vi.unstubAllGlobals();
  });

  it('returns error when no sshHost is configured', async () => {
    const mocks = makeMocks('new-sha');
    const updater = new AgentUpdater(
      mocks.bundler as any, mocks.installer as any,
      mocks.serverRepo as any, mocks.taskRepo as any,
    );

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ version: 'old-sha' }),
    })));

    const result = await updater.checkAndUpdate(makeServer({ sshHost: null }));
    expect(result.status).toBe('error');
    expect(result.message).toContain('Cannot determine SSH host');

    vi.unstubAllGlobals();
  });

  it('updates agent when version mismatch and no running tasks', async () => {
    const mocks = makeMocks('new-sha');
    mocks.installer.update.mockResolvedValue({ success: true, version: 'new-sha' });

    const updater = new AgentUpdater(
      mocks.bundler as any, mocks.installer as any,
      mocks.serverRepo as any, mocks.taskRepo as any,
    );

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ version: 'old-sha' }),
    })));

    const result = await updater.checkAndUpdate(makeServer());
    expect(result.status).toBe('updated');
    expect(mocks.installer.update).toHaveBeenCalledWith('user@remote', '100.64.0.1', 'tok123', 'system');
    expect(mocks.serverRepo.updateAgentVersion).toHaveBeenCalledWith('test-server', 'new-sha');

    vi.unstubAllGlobals();
  });

  it('returns error when update fails', async () => {
    const mocks = makeMocks('new-sha');
    mocks.installer.update.mockResolvedValue({ success: false, version: 'new-sha', error: 'Transfer failed' });

    const updater = new AgentUpdater(
      mocks.bundler as any, mocks.installer as any,
      mocks.serverRepo as any, mocks.taskRepo as any,
    );

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ version: 'old-sha' }),
    })));

    const result = await updater.checkAndUpdate(makeServer());
    expect(result.status).toBe('error');
    expect(result.message).toBe('Transfer failed');
    expect(mocks.serverRepo.updateAgentVersion).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('checkAllServers filters to agent-type servers only', async () => {
    const mocks = makeMocks();
    mocks.serverRepo.findAll.mockReturnValue([
      makeServer({ name: 'local-1', type: 'local', host: null, agentPort: null, agentToken: null }),
      makeServer({ name: 'local-2', type: 'local', host: null, agentPort: null, agentToken: null }),
      makeServer({ name: 'agent-1', type: 'agent' }),
    ]);

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ version: mocks.bundler.getBundleHash() }),
    })));

    const updater = new AgentUpdater(
      mocks.bundler as any, mocks.installer as any,
      mocks.serverRepo as any, mocks.taskRepo as any,
    );

    const results = await updater.checkAllServers();
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('agent-1');

    vi.unstubAllGlobals();
  });
});
