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
const homeDir = '/home/agent';
const mirrorDir = '/home/agent/.azito/repos/hash.git';

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
    resolveHomeDir: vi.fn(async () => homeDir),
    mirrorDir: vi.fn(() => mirrorDir),
    ensureMirror: vi.fn(async () => {}),
    getMirrorBranchSha: vi.fn(async () => null),
    fetchBundleIntoMirror: vi.fn(async () => {}),
    cloneWorkingDirFromMirror: vi.fn(async () => {}),
    fetchWorkingDirFromMirror: vi.fn(async () => {}),
    ensureDetachedHead: vi.fn(async () => {}),
    setDummyOrigin: vi.fn(async () => {}),
    repoExists: vi.fn(async () => false),
    cleanup: vi.fn(async () => {}),
    ...overrides,
  } as any;
}

function mockSftpService() {
  return { upload: vi.fn(async () => {}) } as any;
}

function mockDistRepo() {
  return {
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
  it('returns already_current when the mirror already has headSha and still ensures workingDir', async () => {
    const remoteBundleOps = mockRemoteBundleOps({
      getMirrorBranchSha: vi.fn(async () => sha),
      repoExists: vi.fn(async () => true),
    });
    const service = new FetchDistributionService(mockHubRepoCache(), remoteBundleOps, mockSftpService(), mockDistRepo());
    const result = await service.distribute(makeParams());
    expect(result.status).toBe('already_current');
    expect(result.sha).toBe(sha);
    // Transfer is skipped...
    expect(remoteBundleOps.fetchBundleIntoMirror).not.toHaveBeenCalled();
    // ...but workingDir is still (re-)ensured from the mirror.
    expect(remoteBundleOps.fetchWorkingDirFromMirror).toHaveBeenCalled();
    // Detach is applied unconditionally on the fetch (existing workingDir)
    // path too — not just after a fresh clone (Issue #87 review finding:
    // without this, a workingDir whose detach failed on a past distribution
    // could never be recovered, since it is never re-cloned).
    expect(remoteBundleOps.ensureDetachedHead).toHaveBeenCalledWith({}, '/home/agent/repo');
  });

  it('distributes full bundle for first-time distribution (no mirror branch yet) and --no-local clones workingDir', async () => {
    const remoteBundleOps = mockRemoteBundleOps({
      getMirrorBranchSha: vi.fn(async () => null),
      repoExists: vi.fn(async () => false),
    });
    const sftpService = mockSftpService();
    const distRepo = mockDistRepo();
    const service = new FetchDistributionService(mockHubRepoCache(), remoteBundleOps, sftpService, distRepo);
    const result = await service.distribute(makeParams());
    expect(result.status).toBe('distributed');
    expect(result.bundleType).toBe('full');
    expect(remoteBundleOps.ensureMirror).toHaveBeenCalledWith({}, mirrorDir);
    expect(sftpService.upload).toHaveBeenCalled();
    expect(remoteBundleOps.fetchBundleIntoMirror).toHaveBeenCalled();
    expect(remoteBundleOps.cloneWorkingDirFromMirror).toHaveBeenCalled();
    // Detach is applied on the clone path too, as its own step after clone
    // returns — not fused into cloneWorkingDirFromMirror itself (Issue #87
    // review finding).
    expect(remoteBundleOps.ensureDetachedHead).toHaveBeenCalledWith({}, '/home/agent/repo');
    expect(remoteBundleOps.setDummyOrigin).toHaveBeenCalled();
    expect(distRepo.upsert).toHaveBeenCalledWith('iso-server', 1, sha, 'full');
  });

  it('uses an incremental bundle keyed off the mirror ref, and forced-fetches an existing workingDir', async () => {
    const prevSha = 'b'.repeat(40);
    const remoteBundleOps = mockRemoteBundleOps({
      getMirrorBranchSha: vi.fn(async () => prevSha),
      repoExists: vi.fn(async () => true),
    });
    const hubRepoCache = mockHubRepoCache();
    const service = new FetchDistributionService(hubRepoCache, remoteBundleOps, mockSftpService(), mockDistRepo());
    const result = await service.distribute(makeParams());
    expect(result.status).toBe('distributed');
    expect(result.bundleType).toBe('incremental');
    expect(hubRepoCache.createBundle).toHaveBeenCalledWith(identity, 'main', prevSha);
    expect(remoteBundleOps.fetchWorkingDirFromMirror).toHaveBeenCalled();
  });

  // Regression test for the confirmed permanent-failure bug: `applyFetch`'s
  // old refspec was non-forced, so once the upstream branch was force-pushed
  // (mirror ref no longer an ancestor of the new bundle), delivery would
  // fail non-fast-forward forever. `fetchBundleIntoMirror` now uses a forced
  // (`+`) refspec, so a single incremental attempt succeeds even when the
  // mirror's ref is not an ancestor of the bundle's tip.
  it('succeeds via forced refspec when the mirror ref is not an ancestor of the new bundle (force-push case)', async () => {
    const staleMirrorSha = 'c'.repeat(40); // diverged, e.g. by an upstream force-push
    const remoteBundleOps = mockRemoteBundleOps({
      getMirrorBranchSha: vi.fn(async () => staleMirrorSha),
      repoExists: vi.fn(async () => true),
      // In production a non-forced refspec would reject here; the forced
      // implementation just succeeds, so the mock reflects that.
      fetchBundleIntoMirror: vi.fn(async () => {}),
    });
    const hubRepoCache = mockHubRepoCache();
    const distRepo = mockDistRepo();
    const service = new FetchDistributionService(hubRepoCache, remoteBundleOps, mockSftpService(), distRepo);
    const result = await service.distribute(makeParams());
    expect(result.status).toBe('distributed');
    expect(result.bundleType).toBe('incremental');
    expect(remoteBundleOps.fetchBundleIntoMirror).toHaveBeenCalledTimes(1);
    expect(distRepo.upsert).toHaveBeenCalledWith('iso-server', 1, sha, 'incremental');
  });

  it('falls back to a full bundle, retried once, when the incremental fetch into the mirror fails', async () => {
    const prevSha = 'b'.repeat(40);
    const remoteBundleOps = mockRemoteBundleOps({
      getMirrorBranchSha: vi.fn(async () => prevSha),
      repoExists: vi.fn(async () => true),
      fetchBundleIntoMirror: vi.fn()
        .mockRejectedValueOnce(new Error('git fetch bundle into mirror failed: fatal: rejected'))
        .mockResolvedValueOnce(undefined),
    });
    const hubRepoCache = mockHubRepoCache();
    const sftpService = mockSftpService();
    const service = new FetchDistributionService(hubRepoCache, remoteBundleOps, sftpService, mockDistRepo());
    const result = await service.distribute(makeParams());
    expect(result.status).toBe('distributed');
    expect(result.bundleType).toBe('full');
    expect(sftpService.upload).toHaveBeenCalledTimes(2);
    expect(remoteBundleOps.fetchBundleIntoMirror).toHaveBeenCalledTimes(2);
  });

  it('falls back to full bundle when incremental verify fails', async () => {
    const prevSha = 'b'.repeat(40);
    const remoteBundleOps = mockRemoteBundleOps({
      getMirrorBranchSha: vi.fn(async () => prevSha),
      repoExists: vi.fn(async () => true),
      verify: vi.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    });
    const hubRepoCache = mockHubRepoCache();
    const sftpService = mockSftpService();
    const service = new FetchDistributionService(hubRepoCache, remoteBundleOps, sftpService, mockDistRepo());
    const result = await service.distribute(makeParams());
    expect(result.status).toBe('distributed');
    expect(result.bundleType).toBe('full');
    expect(sftpService.upload).toHaveBeenCalledTimes(2);
  });

  it('does not retry (fails outright) when the full-bundle delivery itself fails', async () => {
    const remoteBundleOps = mockRemoteBundleOps({
      getMirrorBranchSha: vi.fn(async () => null), // no prerequisite -> starts at 'full' directly
      repoExists: vi.fn(async () => false),
      fetchBundleIntoMirror: vi.fn(async () => { throw new Error('git fetch bundle into mirror failed: fatal: disk full'); }),
    });
    const service = new FetchDistributionService(mockHubRepoCache(), remoteBundleOps, mockSftpService(), mockDistRepo());
    const result = await service.distribute(makeParams());
    expect(result.status).toBe('failed');
    expect(remoteBundleOps.fetchBundleIntoMirror).toHaveBeenCalledTimes(1);
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
  // same server+repository both query the mirror's refs before either has
  // applied its own bundle, so they could build off the same prerequisite
  // and interleave their `fetch --atomic` into the shared mirror.
  // `distribute()` serializes by `${server.name}:${repositoryId}` via
  // `KeyedMutex` — verify the second call's mirror-ref read only happens
  // after the first call's mirror write.
  describe('serialization of concurrent distribute() calls for the same server+repo', () => {
    it('does not let a second call start its own mirror-ref read until the first call has applied its fetch', async () => {
      const order: string[] = [];
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      // A stateful mock (unlike the fixed-snapshot mocks above) so a read
      // after the first call's write actually observes what it wrote — this
      // is what lets the second call recognize `already_current`.
      let mirrorSha: string | null = null;
      let readCount = 0;
      const remoteBundleOps = mockRemoteBundleOps({
        getMirrorBranchSha: vi.fn(async () => {
          readCount += 1;
          order.push(`read-${readCount}`);
          return mirrorSha;
        }),
        fetchBundleIntoMirror: vi.fn(async () => {
          order.push('mirror-write');
          mirrorSha = sha;
        }),
        repoExists: vi.fn(async () => true),
      });

      // Block on the first call's SFTP upload (a real `await` point inside
      // `distribute()`) so the second call has a real chance to race in if
      // the mutex did not serialize the two runs.
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
      const service = new FetchDistributionService(hubRepoCache, remoteBundleOps, sftpService as any, mockDistRepo());

      const first = service.distribute(makeParams());
      // Give the first call a chance to actually start before queuing the second.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const second = service.distribute(makeParams());
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // The second call must not have started (and thus must not have done
      // its own mirror-ref read) yet — it is queued behind the first.
      expect(order).toEqual(['read-1', 'first-upload-start']);

      releaseFirst();
      const [firstResult, secondResult] = await Promise.all([first, second]);

      // The second call's mirror-ref read observes what the first call just
      // wrote, so it returns `already_current` right after its read —
      // without ever reaching (or needing to reach) its own upload.
      expect(order).toEqual([
        'read-1',
        'first-upload-start',
        'first-upload-end',
        'mirror-write',
        'read-2',
      ]);
      expect(firstResult.status).toBe('distributed');
      expect(secondResult.status).toBe('already_current');
    });

    // Issue #87 review finding (gpt-5.6-sol): distinct `project_repositories`
    // rows (distinct `repositoryId`) can point at the same canonical
    // repository, which shares the same server-side mirror
    // (`computeRepoHash(repoIdentity)`-keyed). The mutex key must therefore
    // be derived from the repo identity, not the DB row id, or two such
    // rows can concurrently `fetch --atomic` the same mirror unserialized.
    it('serializes calls for the same identity even when repositoryId differs', async () => {
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

      const service = new FetchDistributionService(mockHubRepoCache(), mockRemoteBundleOps(), sftpService as any, mockDistRepo());

      // Same repoIdentity (same mirror), different repositoryId rows.
      const a = service.distribute(makeParams({ repositoryId: 1 }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      const b = service.distribute(makeParams({ repositoryId: 2 }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // `b` must not have started yet — it is queued behind `a` because
      // both share the same mirror (same repoIdentity), regardless of
      // repositoryId.
      expect(order).toEqual(['a-start']);

      releaseA();
      await Promise.all([a, b]);
      expect(order).toEqual(['a-start', 'a-end', 'b-start']);
    });

    it('does not serialize calls with different repoHash (distinct mirrors)', async () => {
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

      const service = new FetchDistributionService(mockHubRepoCache(), mockRemoteBundleOps(), sftpService as any, mockDistRepo());
      const otherIdentity: CanonicalRepositoryIdentity = {
        ...identity,
        repo: 'other-repo',
        httpsUrl: 'https://github.com/owner/other-repo.git',
      };

      const a = service.distribute(makeParams({ repositoryId: 1, repoIdentity: identity }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // A call for a different repoIdentity (different mirror, different
      // mutex key) must proceed immediately, without waiting for `a` to
      // finish, even though repositoryId also happens to differ here.
      const b = service.distribute(makeParams({ repositoryId: 2, repoIdentity: otherIdentity }));
      await b;
      expect(order).toEqual(['a-start', 'b-start']);

      releaseA();
      await a;
      expect(order).toEqual(['a-start', 'b-start', 'a-end']);
    });
  });
});
