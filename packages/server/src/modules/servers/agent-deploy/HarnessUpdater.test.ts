import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HarnessUpdater, computeHarnessHash } from './HarnessUpdater';
import type { ServerConfig } from '../Server';
import type { HarnessInstallOptions, HarnessInstallResult } from './HarnessInstaller';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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
    isolationReport: null, isolationCleanupReport: null,
    defaultMux: 'tmux' as const, muxRuntime: 'system', hostProfile: null,
    createdAt: '2024-01-01',
    ...overrides,
  };
}

function makeMocks() {
  const harnessInstaller = {
    install: vi.fn(async (_host: string, _opts: HarnessInstallOptions): Promise<HarnessInstallResult> => ({ success: true, steps: [] })),
    installLocal: vi.fn(async (_opts: HarnessInstallOptions): Promise<HarnessInstallResult> => ({ success: true, steps: [] })),
  };
  const sshClient = {
    execIsolated: vi.fn(async () => ({ stdout: '', stderr: '', code: 0 })),
    resolveHost: vi.fn((h: string) => ({ host: h, port: 22, username: 'user' })),
    buildConnectOpts: vi.fn(),
  };
  const serverRepo = {
    findAll: vi.fn((): ServerConfig[] => []),
    findByName: vi.fn((): ServerConfig | undefined => undefined),
    create: vi.fn(),
    update: vi.fn(),
    updateAgentVersion: vi.fn(),
    updateFingerprint: vi.fn(),
    clearFingerprint: vi.fn(),
    delete: vi.fn(),
  };
  const mutex = {
    withLock: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  };
  return { harnessInstaller, sshClient, serverRepo, mutex, logger };
}

const OPTIONS = { webhookToken: 'wh-tok', uiToken: 'ui-tok', harnessPrefix: 'dev' };

describe('HarnessUpdater', () => {
  let mocks: ReturnType<typeof makeMocks>;
  let updater: HarnessUpdater;

  beforeEach(() => {
    mocks = makeMocks();
    updater = new HarnessUpdater(
      mocks.harnessInstaller as any, mocks.sshClient as any,
      mocks.serverRepo as any, OPTIONS, mocks.mutex as any, mocks.logger,
    );
    // Stub getHarnessHash to avoid filesystem dependency
    vi.spyOn(updater, 'getHarnessHash').mockReturnValue('abc123deadbeef00');
  });

  it('skips local servers', async () => {
    mocks.serverRepo.findAll.mockReturnValue([makeServer({ type: 'local', name: 'hub' })]);
    const results = await updater.checkAllServers();
    expect(results).toHaveLength(0);
  });

  it('skips when no sshHost is configured', async () => {
    const result = await updater.checkAndUpdate(makeServer({ sshHost: null }));
    expect(result.status).toBe('skipped');
    expect(result.message).toContain('No SSH host');
  });

  it('skips when AZITO_URL is not found in azitoctl env', async () => {
    mocks.sshClient.execIsolated.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    const result = await updater.checkAndUpdate(makeServer());
    expect(result.status).toBe('skipped');
    expect(result.message).toContain('AZITO_URL not found');
  });

  it('returns up_to_date when remote VERSION matches local hash', async () => {
    let callCount = 0;
    mocks.sshClient.execIsolated.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { stdout: 'AZITO_URL=http://hub:3001\n', stderr: '', code: 0 };
      if (callCount === 2) return { stdout: 'abc123deadbeef00\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    const result = await updater.checkAndUpdate(makeServer());
    expect(result.status).toBe('up_to_date');
    expect(mocks.harnessInstaller.install).not.toHaveBeenCalled();
  });

  it('updates when remote VERSION differs from local hash', async () => {
    const srv = makeServer();
    mocks.serverRepo.findByName.mockReturnValue(srv);

    let callCount = 0;
    mocks.sshClient.execIsolated.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { stdout: 'AZITO_URL=http://hub:3001\n', stderr: '', code: 0 };
      if (callCount === 2) return { stdout: 'old-version\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    const result = await updater.checkAndUpdate(srv);
    expect(result.status).toBe('updated');
    expect(mocks.harnessInstaller.install).toHaveBeenCalledTimes(1);

    const installOptions = mocks.harnessInstaller.install.mock.calls[0][1];
    expect(installOptions.azitoUrl).toBe('http://hub:3001');
    expect(installOptions.version).toBe('abc123deadbeef00');
    expect(installOptions.serverName).toBe('test-server');
  });

  it('updates when remote VERSION is missing', async () => {
    const srv = makeServer();
    mocks.serverRepo.findByName.mockReturnValue(srv);

    let callCount = 0;
    mocks.sshClient.execIsolated.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { stdout: 'AZITO_URL=http://hub:3001\n', stderr: '', code: 0 };
      if (callCount === 2) return { stdout: '', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    const result = await updater.checkAndUpdate(srv);
    expect(result.status).toBe('updated');
  });

  it('reads isolationIntent from a fresh server fetch inside the lock', async () => {
    const srvBefore = makeServer({ isolationIntent: false });
    const srvAfterLock = makeServer({ isolationIntent: true });
    mocks.serverRepo.findByName.mockReturnValue(srvAfterLock);

    let callCount = 0;
    mocks.sshClient.execIsolated.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { stdout: 'AZITO_URL=http://hub:3001\n', stderr: '', code: 0 };
      if (callCount === 2) return { stdout: 'old-version\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    await updater.checkAndUpdate(srvBefore);

    const installOptions = mocks.harnessInstaller.install.mock.calls[0][1];
    expect(installOptions.isolationIntent).toBe(true);
    // uiToken is always passed — HarnessInstaller.runSetup withholds --ui-token
    // when isolationIntent is true (tested in HarnessInstaller's own tests).
    expect(installOptions.uiToken).toBe('ui-tok');
  });

  it('does not pass uiToken removal in the install options (HarnessInstaller handles it)', async () => {
    const srv = makeServer({ isolationIntent: true });
    mocks.serverRepo.findByName.mockReturnValue(srv);

    let callCount = 0;
    mocks.sshClient.execIsolated.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { stdout: 'AZITO_URL=http://hub:3001\n', stderr: '', code: 0 };
      if (callCount === 2) return { stdout: 'old\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    await updater.checkAndUpdate(srv);

    const installOptions = mocks.harnessInstaller.install.mock.calls[0][1];
    expect(installOptions.isolationIntent).toBe(true);
    expect(installOptions.uiToken).toBe('ui-tok');
    expect(installOptions.webhookToken).toBe('wh-tok');
  });

  it('returns error when install fails', async () => {
    const srv = makeServer();
    mocks.serverRepo.findByName.mockReturnValue(srv);
    mocks.harnessInstaller.install.mockResolvedValue({ success: false, steps: [], error: 'Transfer failed' });

    let callCount = 0;
    mocks.sshClient.execIsolated.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { stdout: 'AZITO_URL=http://hub:3001\n', stderr: '', code: 0 };
      if (callCount === 2) return { stdout: 'old\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    const result = await updater.checkAndUpdate(srv);
    expect(result.status).toBe('error');
    expect(result.message).toBe('Transfer failed');
  });

  it('returns error when install throws', async () => {
    const srv = makeServer();
    mocks.serverRepo.findByName.mockReturnValue(srv);
    mocks.harnessInstaller.install.mockRejectedValue(new Error('SSH connect failed'));

    let callCount = 0;
    mocks.sshClient.execIsolated.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { stdout: 'AZITO_URL=http://hub:3001\n', stderr: '', code: 0 };
      if (callCount === 2) return { stdout: 'old\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    const result = await updater.checkAndUpdate(srv);
    expect(result.status).toBe('error');
    expect(result.message).toBe('SSH connect failed');
  });

  it('skips when server disappears inside the lock', async () => {
    mocks.serverRepo.findByName.mockReturnValue(undefined);

    let callCount = 0;
    mocks.sshClient.execIsolated.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { stdout: 'AZITO_URL=http://hub:3001\n', stderr: '', code: 0 };
      if (callCount === 2) return { stdout: 'old\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    const result = await updater.checkAndUpdate(makeServer());
    expect(result.status).toBe('skipped');
    expect(mocks.harnessInstaller.install).not.toHaveBeenCalled();
  });

  it('stores last result per server and exposes via getLastResult', async () => {
    mocks.sshClient.execIsolated.mockResolvedValue({ stdout: '', stderr: '', code: 0 });
    await updater.checkAndUpdate(makeServer({ name: 'srv1' }));
    const result = updater.getLastResult('srv1');
    expect(result).toBeDefined();
    expect(result!.status).toBe('skipped');
  });

  it('checkAllServers filters to agent-type servers only', async () => {
    mocks.serverRepo.findAll.mockReturnValue([
      makeServer({ name: 'local-1', type: 'local' }),
      makeServer({ name: 'agent-1', type: 'agent', sshHost: null }),
    ]);
    const results = await updater.checkAllServers();
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('agent-1');
  });

  it('parses shell-quoted AZITO_URL from azitoctl env', async () => {
    const srv = makeServer();
    mocks.serverRepo.findByName.mockReturnValue(srv);

    let callCount = 0;
    mocks.sshClient.execIsolated.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return { stdout: "AZITO_URL=$'http://hub:3001'\n", stderr: '', code: 0 };
      if (callCount === 2) return { stdout: 'old\n', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    });

    await updater.checkAndUpdate(srv);
    const installOptions = mocks.harnessInstaller.install.mock.calls[0][1];
    expect(installOptions.azitoUrl).toBe('http://hub:3001');
  });
});

describe('computeHarnessHash', () => {
  it('produces a deterministic 16-char hex hash', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hash-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'file1.txt'), 'hello');
      fs.mkdirSync(path.join(tmpDir, 'subdir'));
      fs.writeFileSync(path.join(tmpDir, 'subdir', 'file2.txt'), 'world');

      const hash1 = computeHarnessHash(tmpDir);
      const hash2 = computeHarnessHash(tmpDir);
      expect(hash1).toBe(hash2);
      expect(hash1).toMatch(/^[0-9a-f]{16}$/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('excludes VERSION file from hash', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hash-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'file1.txt'), 'hello');
      const hashBefore = computeHarnessHash(tmpDir);

      fs.writeFileSync(path.join(tmpDir, 'VERSION'), 'abc123');
      const hashAfter = computeHarnessHash(tmpDir);
      expect(hashBefore).toBe(hashAfter);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('excludes node_modules and .git', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hash-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'file1.txt'), 'hello');
      const hashBefore = computeHarnessHash(tmpDir);

      fs.mkdirSync(path.join(tmpDir, 'node_modules'));
      fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg.json'), '{}');
      fs.mkdirSync(path.join(tmpDir, '.git'));
      fs.writeFileSync(path.join(tmpDir, '.git', 'HEAD'), 'ref');
      const hashAfter = computeHarnessHash(tmpDir);
      expect(hashBefore).toBe(hashAfter);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('changes when a file changes', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hash-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'file1.txt'), 'hello');
      const hashBefore = computeHarnessHash(tmpDir);

      fs.writeFileSync(path.join(tmpDir, 'file1.txt'), 'world');
      const hashAfter = computeHarnessHash(tmpDir);
      expect(hashBefore).not.toBe(hashAfter);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});
