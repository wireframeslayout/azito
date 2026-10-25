import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KeyedMutex } from '../../../shared/keyedMutex';
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
    hostProfile: null, sshHostFingerprint: null,
    isolationIntent: false,
    isolationVerifiedAt: null,
    isolationReport: null, isolationCleanupReport: null,
    defaultMux: 'tmux' as const, muxRuntime: 'system',
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
    findByName: vi.fn((): ServerConfig | null => makeServer()),
    create: vi.fn(),
    update: vi.fn(),
    updateAgentVersion: vi.fn(), updateHostProfile: vi.fn(),
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

  const hostRecorder = {
    record: vi.fn(async () => null),
    recordIfUnknown: vi.fn(async () => null),
  };

  return { bundler, installer, serverRepo, taskRepo, hostRecorder };
}

describe('AgentUpdater', () => {
  it('returns up_to_date for non-agent servers', async () => {
    const mocks = makeMocks();
    const updater = new AgentUpdater(
      mocks.bundler as any, mocks.installer as any,
      mocks.serverRepo as any, mocks.taskRepo as any, mocks.hostRecorder as any, new KeyedMutex(), { warn: vi.fn() },
    );

    const result = await updater.checkAndUpdate(makeServer({ type: 'local' }));
    expect(result.status).toBe('up_to_date');
  });

  it('returns up_to_date for agent without host', async () => {
    const mocks = makeMocks();
    const updater = new AgentUpdater(
      mocks.bundler as any, mocks.installer as any,
      mocks.serverRepo as any, mocks.taskRepo as any, mocks.hostRecorder as any, new KeyedMutex(), { warn: vi.fn() },
    );

    const result = await updater.checkAndUpdate(makeServer({ host: null }));
    expect(result.status).toBe('up_to_date');
  });

  it('returns error when agent is unreachable and no sshHost is configured for recovery', async () => {
    const mocks = makeMocks('new-sha');
    const updater = new AgentUpdater(
      mocks.bundler as any, mocks.installer as any,
      mocks.serverRepo as any, mocks.taskRepo as any, mocks.hostRecorder as any, new KeyedMutex(), { warn: vi.fn() },
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
      mocks.serverRepo as any, mocks.taskRepo as any, mocks.hostRecorder as any, new KeyedMutex(), { warn: vi.fn() },
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

    expect(mocks.installer.recoverAgent).toHaveBeenCalledWith('user@remote', '100.64.0.1', 'tok123', null, 'system');
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
      mocks.serverRepo as any, mocks.taskRepo as any, mocks.hostRecorder as any, new KeyedMutex(), { warn: vi.fn() },
    );

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))));

    const resultPromise = updater.checkAndUpdate(makeServer());
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(mocks.installer.recoverAgent).toHaveBeenCalledWith('user@remote', '100.64.0.1', 'tok123', null, 'system');
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
      mocks.serverRepo as any, mocks.taskRepo as any, mocks.hostRecorder as any, new KeyedMutex(), { warn: vi.fn() },
    );

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))));

    const resultPromise = updater.checkAndUpdate(makeServer());
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(mocks.installer.recoverAgent).toHaveBeenCalledWith('user@remote', '100.64.0.1', 'tok123', null, 'system');
    expect(result.status).toBe('error');
    expect(result.message).toContain('SSH 経由の復旧も失敗');

    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('restarts an unreachable Windows agent through recoverAgent like any other, then checks health again', async () => {
    vi.useFakeTimers();
    const mocks = makeMocks('abc1234');
    mocks.installer.recoverAgent.mockResolvedValue('taskscheduler' as never);
    const updater = new AgentUpdater(
      mocks.bundler as any, mocks.installer as any,
      mocks.serverRepo as any, mocks.taskRepo as any, mocks.hostRecorder as any, new KeyedMutex(), { warn: vi.fn() },
    );
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue({ ok: true, json: async () => ({ version: 'abc1234' }) });
    vi.stubGlobal('fetch', fetchMock);

    const pending = updater.checkAndUpdate(makeServer({ hostProfile: { platform: 'win32', arch: 'x64' } }));
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;

    expect(mocks.installer.recoverAgent).toHaveBeenCalledWith('user@remote', '100.64.0.1', 'tok123', { platform: 'win32', arch: 'x64' }, 'system');
    expect(result.status).toBe('up_to_date');
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('runs the update inside the per-server lock (the recovery watchdog takes the same one) and shows a warning of the update', async () => {
    const mocks = makeMocks('new-sha');
    const lock = new KeyedMutex();
    let takenDuringUpdate: boolean | undefined;
    let other: Promise<void> | undefined;
    mocks.installer.update.mockImplementation(async () => {
      let acquired = false;
      other = lock.withLock('test-server', async () => { acquired = true; });
      await new Promise((resolve) => setTimeout(resolve, 20));
      takenDuringUpdate = acquired;
      return { success: true, version: 'new-sha', warning: 'Old releases left in place: aaaaaaaaaaaa (in use)' };
    });
    const logger = { warn: vi.fn() };
    const updater = new AgentUpdater(
      mocks.bundler as any, mocks.installer as any,
      mocks.serverRepo as any, mocks.taskRepo as any, mocks.hostRecorder as any, lock, logger,
    );
    const win = makeServer({ hostProfile: { platform: 'win32', arch: 'x64' } });
    mocks.serverRepo.findByName.mockReturnValue(win);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ version: 'old-sha' }) })));

    const result = await updater.checkAndUpdate(win);
    await other;

    // While update() ran, a second taker of the same key had to wait.
    expect(takenDuringUpdate).toBe(false);
    expect(result).toMatchObject({ status: 'updated', currentVersion: 'new-sha', message: 'Old releases left in place: aaaaaaaaaaaa (in use)' });
    expect(mocks.installer.update).toHaveBeenCalledWith('user@remote', '100.64.0.1', 'tok123', { platform: 'win32', arch: 'x64' }, 'system');
    // The warning of the update is logged here, not left to the caller of checkAllServers.
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Old releases left in place: aaaaaaaaaaaa (in use)'));
    vi.unstubAllGlobals();
  });

  it('updates with the token registered once the lock is held, and not at all when it changed while waiting (a reinstall wrote a new one)', async () => {
    const mocks = makeMocks('new-sha');
    const lock = new KeyedMutex();
    const logger = { warn: vi.fn() };
    const updater = new AgentUpdater(
      mocks.bundler as any, mocks.installer as any,
      mocks.serverRepo as any, mocks.taskRepo as any, mocks.hostRecorder as any, lock, logger,
    );
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ version: 'old-sha' }) })));
    const seen = makeServer({ agentToken: 'old-token' });
    // A reinstall holds the lock, and registers a new token before it lets go.
    let finishReinstall!: () => void;
    const reinstall = lock.withLock('test-server', () => new Promise<void>((resolve) => { finishReinstall = resolve; }));
    mocks.serverRepo.findByName.mockReturnValue(makeServer({ agentToken: 'new-token' }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const pending = updater.checkAndUpdate(seen);
    finishReinstall();
    await reinstall;
    const result = await pending;

    expect(result.status).toBe('skipped');
    expect(result.message).toContain('reinstalled');
    // A skipped update is said in the log (here, once: the caller of checkAllServers does not print it).
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Update skipped'));
    expect(mocks.installer.update).not.toHaveBeenCalled();
    expect(mocks.serverRepo.updateAgentVersion).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('skips the update of a server that was deleted while it waited, and does nothing when the reinstall already brought the current version', async () => {
    const mocks = makeMocks('new-sha');
    const updater = new AgentUpdater(
      mocks.bundler as any, mocks.installer as any,
      mocks.serverRepo as any, mocks.taskRepo as any, mocks.hostRecorder as any, new KeyedMutex(), { warn: vi.fn() },
    );
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ version: 'old-sha' }) })));
    mocks.serverRepo.findByName.mockReturnValue(null);
    expect((await updater.checkAndUpdate(makeServer())).status).toBe('skipped');

    mocks.serverRepo.findByName.mockReturnValue(makeServer());
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ version: 'old-sha' }) })
      .mockResolvedValue({ ok: true, json: async () => ({ version: 'new-sha' }) });
    vi.stubGlobal('fetch', fetchMock);
    const result = await updater.checkAndUpdate(makeServer());
    expect(result).toMatchObject({ status: 'up_to_date', currentVersion: 'new-sha' });
    expect(mocks.installer.update).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('returns up_to_date when versions match', async () => {
    const sha = 'abc1234';
    const mocks = makeMocks(sha);
    const updater = new AgentUpdater(
      mocks.bundler as any, mocks.installer as any,
      mocks.serverRepo as any, mocks.taskRepo as any, mocks.hostRecorder as any, new KeyedMutex(), { warn: vi.fn() },
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
      mocks.serverRepo as any, mocks.taskRepo as any, mocks.hostRecorder as any, new KeyedMutex(), { warn: vi.fn() },
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
      mocks.serverRepo as any, mocks.taskRepo as any, mocks.hostRecorder as any, new KeyedMutex(), { warn: vi.fn() },
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
      mocks.serverRepo as any, mocks.taskRepo as any, mocks.hostRecorder as any, new KeyedMutex(), { warn: vi.fn() },
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
      mocks.serverRepo as any, mocks.taskRepo as any, mocks.hostRecorder as any, new KeyedMutex(), { warn: vi.fn() },
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
      mocks.serverRepo as any, mocks.taskRepo as any, mocks.hostRecorder as any, new KeyedMutex(), { warn: vi.fn() },
    );

    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ version: 'old-sha' }),
    })));

    const result = await updater.checkAndUpdate(makeServer());
    expect(result.status).toBe('updated');
    expect(mocks.installer.update).toHaveBeenCalledWith('user@remote', '100.64.0.1', 'tok123', null, 'system');
    expect(mocks.serverRepo.updateAgentVersion).toHaveBeenCalledWith('test-server', 'new-sha');

    vi.unstubAllGlobals();
  });

  it('returns error when update fails', async () => {
    const mocks = makeMocks('new-sha');
    mocks.installer.update.mockResolvedValue({ success: false, version: 'new-sha', error: 'Transfer failed' });

    const updater = new AgentUpdater(
      mocks.bundler as any, mocks.installer as any,
      mocks.serverRepo as any, mocks.taskRepo as any, mocks.hostRecorder as any, new KeyedMutex(), { warn: vi.fn() },
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
      mocks.serverRepo as any, mocks.taskRepo as any, mocks.hostRecorder as any, new KeyedMutex(), { warn: vi.fn() },
    );

    const results = await updater.checkAllServers();
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('agent-1');

    vi.unstubAllGlobals();
  });

  describe('recording the agent host', () => {
    const reachable = (version: string) => vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ version }) })));
    const build = (mocks: ReturnType<typeof makeMocks>) => new AgentUpdater(
      mocks.bundler as any, mocks.installer as any,
      mocks.serverRepo as any, mocks.taskRepo as any, mocks.hostRecorder as any, new KeyedMutex(), { warn: vi.fn() },
    );

    it('asks for the host of a reached agent that has none recorded (connection)', async () => {
      const mocks = makeMocks('abc1234');
      reachable('abc1234');
      const server = makeServer();
      const result = await build(mocks).checkAndUpdate(server);
      expect(result.status).toBe('up_to_date');
      expect(mocks.hostRecorder.recordIfUnknown).toHaveBeenCalledWith(server);
      expect(mocks.hostRecorder.record).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('asks again after a successful update, because the new agent may be the first to report it', async () => {
      const mocks = makeMocks('new-sha');
      reachable('old-sha');
      mocks.installer.update.mockResolvedValue({ success: true, version: 'new-sha' });
      const server = makeServer();
      const result = await build(mocks).checkAndUpdate(server);
      expect(result).toMatchObject({ status: 'updated', currentVersion: 'new-sha' });
      expect(mocks.hostRecorder.record).toHaveBeenCalledWith(server);
      vi.unstubAllGlobals();
    });

    it('does not ask when the agent could not be reached', async () => {
      const mocks = makeMocks('abc1234');
      vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))));
      const result = await build(mocks).checkAndUpdate(makeServer({ sshHost: null }));
      expect(result.status).toBe('error');
      expect(mocks.hostRecorder.recordIfUnknown).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });

    it('keeps the update status when the host cannot be recorded afterwards, and reports the reason beside it', async () => {
      const mocks = makeMocks('new-sha');
      reachable('old-sha');
      mocks.installer.update.mockResolvedValue({ success: true, version: 'new-sha' });
      mocks.hostRecorder.record.mockRejectedValue(Object.assign(new Error('Unsupported host freebsd/x64'), { code: 'unsupported_host' }));
      const result = await build(mocks).checkAndUpdate(makeServer());
      expect(result).toMatchObject({ status: 'updated', currentVersion: 'new-sha', hostError: 'Unsupported host freebsd/x64' });
      vi.unstubAllGlobals();
    });

    it('sets no hostError for the read of an unrecorded host: that read logs its own failures and does not reject (only the record() after an update can set hostError)', async () => {
      const mocks = makeMocks('abc1234');
      reachable('abc1234');
      mocks.hostRecorder.recordIfUnknown.mockResolvedValue(null);
      const result = await build(mocks).checkAndUpdate(makeServer());
      expect(result).toEqual({ name: 'test-server', status: 'up_to_date', currentVersion: 'abc1234' });
      vi.unstubAllGlobals();
    });
  });
});
