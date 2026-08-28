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

  // Issue #87 review finding: two concurrent `distribute()` calls for the
  // same server+repository both read `lastDistributedSha` from the DB
  // before either writes it back, so their `upsert()`s can land out of
  // order and silently record the wrong SHA. `distribute()` now serializes
  // by `${server.name}:${repositoryId}` via `KeyedMutex` — verify the
  // second call's DB read only happens after the first call's DB write.
  describe('serialization of concurrent distribute() calls for the same server+repo', () => {
    it('does not let a second call start its own read until the first call has written', async () => {
      const order: string[] = [];
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      // A stateful mock (unlike `mockDistRepo()`'s fixed-snapshot mock) so a
      // read after the first call's write actually observes what it wrote —
      // this is what lets the second call recognize `already_current`.
      let stored: { lastDistributedSha: string; bundleType: 'full' | 'incremental' } | null = null;
      let readCount = 0;
      const distRepo = {
        findByServerAndRepo: vi.fn(() => {
          readCount += 1;
          order.push(`read-${readCount}`);
          return stored;
        }),
        upsert: vi.fn((_serverName: string, _repositoryId: number, sha: string, bundleType: 'full' | 'incremental') => {
          order.push('write');
          stored = { lastDistributedSha: sha, bundleType };
        }),
        deleteByServer: vi.fn(),
      };

      // Block on the first call's SFTP upload (a real `await` point inside
      // `distribute()`, unlike `ensureFetched()` which is synchronous in
      // production) so the second call has a real chance to race in if the
      // mutex did not serialize the two runs.
      let uploadCount = 0;
      const sftpService = {
        upload: vi.fn(async () => {
          uploadCount += 1;
          if (uploadCount === 1) {
            order.push('first-upload-start');
            await firstGate;
            order.push('first-upload-end');
          } else {
            order.push('second-upload-start');
          }
        }),
      };

      const hubRepoCache = mockHubRepoCache();
      const service = new FetchDistributionService(hubRepoCache, mockRemoteBundleOps(), sftpService as any, distRepo as any);

      const first = service.distribute(makeParams());
      // Give the first call a chance to actually start before queuing the second.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const second = service.distribute(makeParams());
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // The second call must not have started (and thus must not have done
      // its own DB read) yet — it is queued behind the first.
      expect(order).toEqual(['read-1', 'first-upload-start']);

      releaseFirst();
      const [firstResult, secondResult] = await Promise.all([first, second]);

      // The second call's SHA matches what the first call just wrote, so it
      // returns `already_current` right after its read — without ever
      // reaching (or needing to reach) its own upload.
      expect(order).toEqual([
        'read-1',
        'first-upload-start',
        'first-upload-end',
        'write',
        'read-2',
      ]);
      expect(firstResult.status).toBe('distributed');
      expect(secondResult.status).toBe('already_current');
    });

    it('does not serialize calls for different server/repository keys', async () => {
      const order: string[] = [];
      let releaseA!: () => void;
      const gateA = new Promise<void>((resolve) => {
        releaseA = resolve;
      });

      let call = 0;
      const sftpService = {
        upload: vi.fn(async () => {
          call += 1;
          if (call === 1) {
            order.push('a-start');
            await gateA;
            order.push('a-end');
          } else {
            order.push('b-start');
          }
        }),
      };

      const service = new FetchDistributionService(mockHubRepoCache(), mockRemoteBundleOps(), sftpService as any, mockDistRepo(null));

      const a = service.distribute(makeParams({ repositoryId: 1 }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // A call for a different repositoryId (different mutex key) must
      // proceed immediately, without waiting for `a` to finish.
      const b = service.distribute(makeParams({ repositoryId: 2 }));
      await b;
      expect(order).toEqual(['a-start', 'b-start']);

      releaseA();
      await a;
      expect(order).toEqual(['a-start', 'b-start', 'a-end']);
    });
  });
});
