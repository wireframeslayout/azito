import { describe, it, expect, vi } from 'vitest';
import { FetchDistributionService } from './FetchDistributionService';
import type { CanonicalRepositoryIdentity } from '../resolveCanonicalRepositoryIdentity';

const identity: CanonicalRepositoryIdentity = {
  provider: 'github',
  host: 'github.com',
  owner: 'owner',
  repo: 'repo',
  httpsUrl: 'https://github.com/owner/repo.git',
};

const sha = 'a'.repeat(40);

function mockHubRepoCache(overrides: Record<string, any> = {}) {
  return {
    ensureFetched: vi.fn(() => sha),
    createBundle: vi.fn(() => ({ bundlePath: '/tmp/test.bundle', headSha: sha })),
    ...overrides,
  } as any;
}

function mockRemoteBundleOps(overrides: Record<string, any> = {}) {
  return {
    verify: vi.fn(async () => true),
    applyClone: vi.fn(async () => {}),
    applyFetch: vi.fn(async () => {}),
    setDummyOrigin: vi.fn(async () => {}),
    repoExists: vi.fn(async () => false),
    cleanup: vi.fn(async () => {}),
    ...overrides,
  } as any;
}

function mockSftpService() {
  return { upload: vi.fn(async () => {}) } as any;
}

function mockDistRepo(state: any = null) {
  return {
    findByServerAndRepo: vi.fn(() => state),
    upsert: vi.fn(),
    deleteByServer: vi.fn(),
  } as any;
}

const makeServer = (overrides: Record<string, any> = {}): import('../../servers/Server').ServerConfig => ({
  name: 'iso-server',
  type: 'agent',
  host: '100.64.0.2',
  agentPort: 4001,
  agentToken: 'test-token',
  agentVersion: null,
  sshHost: 'user@host',
  muxRuntime: 'system',
  sshHostFingerprint: null,
  isolationIntent: true,
  isolationVerifiedAt: null,
  isolationReport: null,
  isolationCleanupReport: null,
  createdAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

const makeParams = (overrides: Record<string, any> = {}) => ({
  server: makeServer(),
  transport: {} as any,
  repoIdentity: identity,
  token: 'ghp_test',
  branch: 'main',
  workingDir: '/home/agent/repo',
  repositoryId: 1,
  ...overrides,
});

describe('FetchDistributionService', () => {
  it('returns already_current when SHA matches', async () => {
    const distRepo = mockDistRepo({ lastDistributedSha: sha, bundleType: 'full' });
    const service = new FetchDistributionService(mockHubRepoCache(), mockRemoteBundleOps(), mockSftpService(), distRepo);
    const result = await service.distribute(makeParams());
    expect(result.status).toBe('already_current');
    expect(result.sha).toBe(sha);
  });

  it('distributes full bundle for first-time distribution', async () => {
    const distRepo = mockDistRepo(null);
    const remoteBundleOps = mockRemoteBundleOps({ repoExists: vi.fn(async () => false) });
    const sftpService = mockSftpService();
    const service = new FetchDistributionService(mockHubRepoCache(), remoteBundleOps, sftpService, distRepo);
    const result = await service.distribute(makeParams());
    expect(result.status).toBe('distributed');
    expect(result.bundleType).toBe('full');
    expect(sftpService.upload).toHaveBeenCalled();
    expect(remoteBundleOps.applyClone).toHaveBeenCalled();
    expect(distRepo.upsert).toHaveBeenCalledWith('iso-server', 1, sha, 'full');
  });

  it('uses incremental bundle when previous distribution exists', async () => {
    const prevSha = 'b'.repeat(40);
    const distRepo = mockDistRepo({ lastDistributedSha: prevSha, bundleType: 'full' });
    const remoteBundleOps = mockRemoteBundleOps({ repoExists: vi.fn(async () => true) });
    const hubRepoCache = mockHubRepoCache();
    const service = new FetchDistributionService(hubRepoCache, remoteBundleOps, mockSftpService(), distRepo);
    const result = await service.distribute(makeParams());
    expect(result.status).toBe('distributed');
    expect(result.bundleType).toBe('incremental');
    expect(hubRepoCache.createBundle).toHaveBeenCalledWith(identity, 'main', prevSha);
    expect(remoteBundleOps.applyFetch).toHaveBeenCalled();
  });

  it('falls back to full bundle when incremental verify fails', async () => {
    const prevSha = 'b'.repeat(40);
    const distRepo = mockDistRepo({ lastDistributedSha: prevSha, bundleType: 'full' });
    const remoteBundleOps = mockRemoteBundleOps({
      verify: vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      repoExists: vi.fn(async () => true),
    });
    const hubRepoCache = mockHubRepoCache();
    const sftpService = mockSftpService();
    const service = new FetchDistributionService(hubRepoCache, remoteBundleOps, sftpService, distRepo);
    const result = await service.distribute(makeParams());
    expect(result.status).toBe('distributed');
    expect(result.bundleType).toBe('full');
    expect(sftpService.upload).toHaveBeenCalledTimes(2);
  });

  it('returns failed when sshHost is missing', async () => {
    const service = new FetchDistributionService(mockHubRepoCache(), mockRemoteBundleOps(), mockSftpService(), mockDistRepo());
    const result = await service.distribute(makeParams({ server: makeServer({ sshHost: null }) }));
    expect(result.status).toBe('failed');
    expect(result.error).toContain('sshHost');
  });

  it('returns failed when hub fetch throws', async () => {
    const hubRepoCache = mockHubRepoCache({ ensureFetched: vi.fn(() => { throw new Error('auth failed'); }) });
    const service = new FetchDistributionService(hubRepoCache, mockRemoteBundleOps(), mockSftpService(), mockDistRepo());
    const result = await service.distribute(makeParams());
    expect(result.status).toBe('failed');
    expect(result.error).toContain('auth failed');
  });
});
