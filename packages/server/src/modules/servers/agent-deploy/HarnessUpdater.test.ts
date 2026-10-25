import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HarnessUpdater, computeHarnessHash, parseAzitoUrl } from './HarnessUpdater';
import type { ServerConfig } from '../Server';
import type { HarnessInstallOptions, HarnessInstallResult } from './HarnessInstaller';
import { LocalFileOps, localFileOpsHost } from '../../../shared/fs/LocalFileOps';
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

const OK: HarnessInstallResult = { success: true, steps: [] };

function makeMocks(home: string) {
  const harnessInstaller = {
    install: vi.fn(async (_host: string, _opts: HarnessInstallOptions): Promise<HarnessInstallResult> => OK),
    installOnAgent: vi.fn(async (_transport: unknown, _opts: HarnessInstallOptions): Promise<HarnessInstallResult> => OK),
  };
  // The agent's own file operations: the real ones, over a temporary home directory.
  const files = new LocalFileOps(localFileOpsHost({ platform: process.platform === 'win32' ? 'win32' : 'linux', homeDir: home }));
  const transport = { files: () => files };
  const transportFactory = { getAgentTransport: vi.fn((_server: ServerConfig) => transport) };
  const serverRepo = {
    findAll: vi.fn((): ServerConfig[] => []),
    findByName: vi.fn((): ServerConfig | undefined => undefined),
  };
  const mutex = {
    withLock: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  };
  return { harnessInstaller, transport, transportFactory, serverRepo, mutex, logger };
}

const OPTIONS = { webhookToken: 'wh-tok', uiToken: 'ui-tok', harnessPrefix: 'dev' };
const WIN32 = { platform: 'win32' as const, arch: 'x64' as const };

describe('HarnessUpdater', () => {
  let home: string;
  let mocks: ReturnType<typeof makeMocks>;
  let updater: HarnessUpdater;

  /** What a harness install leaves on the agent: the env file with the hub URL, and the VERSION of the copy. */
  function installedHarness(envText: string | null, version: string | null): void {
    fs.mkdirSync(path.join(home, '.azito', 'harness-dev'), { recursive: true });
    if (envText !== null) fs.writeFileSync(path.join(home, '.azito', 'azitoctl-dev.env'), envText);
    if (version !== null) fs.writeFileSync(path.join(home, '.azito', 'harness-dev', 'VERSION'), version);
  }

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-updater-'));
    mocks = makeMocks(home);
    updater = new HarnessUpdater(
      mocks.harnessInstaller as any, mocks.transportFactory as any,
      mocks.serverRepo as any, OPTIONS, mocks.mutex as any, mocks.logger,
    );
    // Stub getHarnessHash to avoid filesystem dependency
    vi.spyOn(updater, 'getHarnessHash').mockReturnValue('abc123deadbeef00');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('skips local servers', async () => {
    mocks.serverRepo.findAll.mockReturnValue([makeServer({ type: 'local', name: 'hub' })]);
    const results = await updater.checkAllServers();
    expect(results).toHaveLength(0);
  });

  it('skips a Unix agent when no sshHost is configured', async () => {
    const result = await updater.checkAndUpdate(makeServer({ sshHost: null }));
    expect(result.status).toBe('skipped');
    expect(result.message).toContain('No SSH host');
    expect(mocks.transportFactory.getAgentTransport).not.toHaveBeenCalled();
  });

  it('skips when AZITO_URL is not found in azitoctl env', async () => {
    const result = await updater.checkAndUpdate(makeServer());
    expect(result.status).toBe('skipped');
    expect(result.message).toContain('AZITO_URL not found');
  });

  it('skips with the reason when the installed harness cannot be read (it is not read as "not installed")', async () => {
    mocks.transportFactory.getAgentTransport.mockImplementation(() => { throw new Error('agent unreachable'); });
    const result = await updater.checkAndUpdate(makeServer());
    expect(result).toMatchObject({ status: 'skipped', message: 'Could not read the installed harness: agent unreachable' });
  });

  it('returns up_to_date when remote VERSION matches local hash', async () => {
    installedHarness('AZITO_URL=http://hub:3001\n', 'abc123deadbeef00\n');
    const result = await updater.checkAndUpdate(makeServer());
    expect(result.status).toBe('up_to_date');
    expect(mocks.harnessInstaller.install).not.toHaveBeenCalled();
  });

  it('updates when remote VERSION differs from local hash', async () => {
    const srv = makeServer();
    mocks.serverRepo.findByName.mockReturnValue(srv);
    installedHarness('AZITO_URL=http://hub:3001\n', 'old-version\n');

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
    installedHarness('AZITO_URL=http://hub:3001\n', null);

    const result = await updater.checkAndUpdate(srv);
    expect(result.status).toBe('updated');
  });

  it('reads isolationIntent from a fresh server fetch inside the lock', async () => {
    const srvBefore = makeServer({ isolationIntent: false });
    const srvAfterLock = makeServer({ isolationIntent: true });
    mocks.serverRepo.findByName.mockReturnValue(srvAfterLock);
    installedHarness('AZITO_URL=http://hub:3001\n', 'old-version\n');

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
    installedHarness('AZITO_URL=http://hub:3001\n', 'old\n');

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
    installedHarness('AZITO_URL=http://hub:3001\n', 'old\n');

    const result = await updater.checkAndUpdate(srv);
    expect(result.status).toBe('error');
    expect(result.message).toBe('Transfer failed');
  });

  it('returns error when install throws', async () => {
    const srv = makeServer();
    mocks.serverRepo.findByName.mockReturnValue(srv);
    mocks.harnessInstaller.install.mockRejectedValue(new Error('SSH connect failed'));
    installedHarness('AZITO_URL=http://hub:3001\n', 'old\n');

    const result = await updater.checkAndUpdate(srv);
    expect(result.status).toBe('error');
    expect(result.message).toBe('SSH connect failed');
  });

  it('skips when server disappears inside the lock', async () => {
    mocks.serverRepo.findByName.mockReturnValue(undefined);
    installedHarness('AZITO_URL=http://hub:3001\n', 'old\n');

    const result = await updater.checkAndUpdate(makeServer());
    expect(result.status).toBe('skipped');
    expect(mocks.harnessInstaller.install).not.toHaveBeenCalled();
  });

  it('stores last result per server and exposes via getLastResult', async () => {
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

  it('updates a Windows agent through the agent itself: no SSH host is needed and install() is not used', async () => {
    const srv = makeServer({ name: 'win-agent', sshHost: null, hostProfile: WIN32 });
    mocks.serverRepo.findAll.mockReturnValue([srv]);
    mocks.serverRepo.findByName.mockReturnValue(srv);
    installedHarness('AZITO_URL="http://hub:3001"\n', 'old\n');

    const results = await updater.checkAllServers();
    expect(results).toEqual([expect.objectContaining({ name: 'win-agent', status: 'updated' })]);
    expect(mocks.harnessInstaller.install).not.toHaveBeenCalled();
    expect(mocks.harnessInstaller.installOnAgent).toHaveBeenCalledTimes(1);
    const [transport, options] = mocks.harnessInstaller.installOnAgent.mock.calls[0];
    expect(transport).toBe(mocks.transport);
    expect(options).toMatchObject({ azitoUrl: 'http://hub:3001', version: 'abc123deadbeef00', serverName: 'win-agent', hostProfile: WIN32 });
  });

  it('parses shell-quoted AZITO_URL from azitoctl env', async () => {
    const srv = makeServer();
    mocks.serverRepo.findByName.mockReturnValue(srv);
    installedHarness("AZITO_URL=$'http://hub:3001'\n", 'old\n');

    await updater.checkAndUpdate(srv);
    const installOptions = mocks.harnessInstaller.install.mock.calls[0][1];
    expect(installOptions.azitoUrl).toBe('http://hub:3001');
  });
});

describe('parseAzitoUrl', () => {
  it.each([
    ['AZITO_URL=http://hub:3001\nAZITO_WEBHOOK_TOKEN=x\n', 'http://hub:3001'],
    ["AZITO_URL='http://hub:3001'", 'http://hub:3001'],
    ['AZITO_URL="http://hub:3001"\r\nAZITO_WEBHOOK_TOKEN="x"\r\n', 'http://hub:3001'],
    ['AZITO_WEBHOOK_TOKEN=x\n', undefined],
    ['AZITO_URL="unterminated\n', undefined],
  ])('%j -> %j', (text, expected) => {
    expect(parseAzitoUrl(text)).toBe(expected);
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
