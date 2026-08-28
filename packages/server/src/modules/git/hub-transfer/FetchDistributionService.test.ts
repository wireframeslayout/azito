import { describe, it, expect, vi } from 'vitest';
import { FetchDistributionService } from './FetchDistributionService';
import { RemoteGitCommandError } from '../execWithSentinel';
import { computeRepoHash } from './repoHash';
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
    syncLocalBranchToTracking: vi.fn(async () => true),
    setDummyOrigin: vi.fn(async () => {}),
    repoExists: vi.fn(async () => false),
    cleanup: vi.fn(async () => {}),
    getStampedRepoHash: vi.fn(async () => null),
    stampRepoHash: vi.fn(async () => {}),
    getOriginUrl: vi.fn(async () => null),
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

/**
 * Flushes the microtask queue completely (a macrotask boundary drains every
 * chained `.then()`/`await` scheduled up to this point) — used instead of a
 * fixed count of `await Promise.resolve()` calls in the concurrency tests
 * below. A fixed count is brittle to internal microtask-hop changes (Issue
 * #87 review, forge/87-mirror follow-up: splitting `hubCacheMutex`'s
 * critical section into a separate `prepareBundle()` step changed exactly
 * how many hops precede the SFTP upload, which broke exact-tick-count
 * assertions here even though the actual serialization behavior being
 * tested was unaffected). Safe to over-flush: a call genuinely blocked on
 * an unresolved gate Promise (e.g. `firstGate` below) cannot be advanced
 * past that gate no matter how many microtasks are flushed.
 */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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
    // localBranchSynced is populated even on the already_current path (Issue
    // #87 review, forge/87-mirror follow-up, Important finding 1) — it still
    // calls ensureWorkingDir(), which still attempts the sync.
    expect(result.localBranchSynced).toBe(true);
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
    expect(result.localBranchSynced).toBe(true);
  });

  it('reports localBranchSynced=false when the workingDir local branch could not be advanced', async () => {
    const remoteBundleOps = mockRemoteBundleOps({
      getMirrorBranchSha: vi.fn(async () => sha),
      repoExists: vi.fn(async () => true),
      // e.g. the branch is checked out in another linked worktree on the
      // server, so `git branch -f` refuses.
      syncLocalBranchToTracking: vi.fn(async () => false),
    });
    const service = new FetchDistributionService(mockHubRepoCache(), remoteBundleOps, mockSftpService(), mockDistRepo());
    const result = await service.distribute(makeParams());
    expect(result.status).toBe('already_current');
    expect(result.localBranchSynced).toBe(false);
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

  // Issue #87 review, fifth pass, Important finding 2: an SFTP upload
  // failure (connect/auth/timeout) is a transfer-layer failure, not a
  // problem with the incremental bundle's content — switching to a full
  // bundle would not help and would only cost a second multi-minute SFTP
  // timeout against an unreachable/rejecting server. It must propagate
  // immediately instead of triggering the incremental->full fallback.
  it('fails immediately (no full-bundle fallback) when the SFTP upload itself fails', async () => {
    const prevSha = 'b'.repeat(40);
    const remoteBundleOps = mockRemoteBundleOps({
      getMirrorBranchSha: vi.fn(async () => prevSha),
      repoExists: vi.fn(async () => true),
    });
    const hubRepoCache = mockHubRepoCache();
    const sftpService = { upload: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) };
    const service = new FetchDistributionService(hubRepoCache, remoteBundleOps, sftpService as any, mockDistRepo());
    const result = await service.distribute(makeParams());
    expect(result.status).toBe('failed');
    expect(result.error).toContain('ECONNREFUSED');
    // Only the one (incremental) upload attempt — no fallback full bundle
    // was built or uploaded.
    expect(sftpService.upload).toHaveBeenCalledTimes(1);
    expect(hubRepoCache.createBundle).toHaveBeenCalledTimes(1);
  });

  // Issue #87 third-party review, seventh pass, Important finding 4: a
  // `RemoteGitCommandError` with `transportFailure: true` means the remote
  // command never completed at all (connection drop, command timeout) — the
  // exit-status sentinel never arrived. Retrying with a different bundle
  // (full instead of incremental) cannot fix a transfer/execution-layer
  // anomaly, and doing so pays the full remote command timeout a second
  // time for nothing. This must be classified the same way an SFTP upload
  // failure already is: fail immediately, no fallback.
  it('fails immediately (no full-bundle fallback) when fetchBundleIntoMirror reports a transport-layer failure (sentinel missing)', async () => {
    const prevSha = 'b'.repeat(40);
    const remoteBundleOps = mockRemoteBundleOps({
      getMirrorBranchSha: vi.fn(async () => prevSha),
      repoExists: vi.fn(async () => true),
      fetchBundleIntoMirror: vi.fn(async () => {
        throw new RemoteGitCommandError('git fetch bundle into mirror did not complete (transport/execution failure)', {
          transportFailure: true,
        });
      }),
    });
    const hubRepoCache = mockHubRepoCache();
    const sftpService = mockSftpService();
    const service = new FetchDistributionService(hubRepoCache, remoteBundleOps, sftpService, mockDistRepo());
    const result = await service.distribute(makeParams());
    expect(result.status).toBe('failed');
    // Only the one (incremental) attempt — no fallback full bundle was
    // built or uploaded.
    expect(sftpService.upload).toHaveBeenCalledTimes(1);
    expect(hubRepoCache.createBundle).toHaveBeenCalledTimes(1);
    expect(remoteBundleOps.fetchBundleIntoMirror).toHaveBeenCalledTimes(1);
  });

  // The mirror image of the test above: when the sentinel DOES arrive and
  // reports a genuine non-zero exit (`transportFailure: false` — git
  // actually ran and rejected THIS bundle's content, e.g. a missing
  // prerequisite commit), the existing incremental->full fallback must
  // still kick in, unchanged from before this fix.
  it('still falls back to full bundle when fetchBundleIntoMirror reports a genuine git rejection (sentinel present, non-zero exit)', async () => {
    const prevSha = 'b'.repeat(40);
    const remoteBundleOps = mockRemoteBundleOps({
      getMirrorBranchSha: vi.fn(async () => prevSha),
      repoExists: vi.fn(async () => true),
      fetchBundleIntoMirror: vi.fn()
        .mockRejectedValueOnce(new RemoteGitCommandError('git fetch bundle into mirror failed: fatal: no prerequisite', {
          transportFailure: false,
        }))
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

  // Cleanup running in a `finally` block must never replace the classified
  // error above with whatever `cleanup()` itself throws (Issue #87
  // third-party review, seventh pass, Important finding 4) — best-effort
  // only.
  it('reports the original transport-layer failure, not a cleanup error, when remote cleanup also fails', async () => {
    const prevSha = 'b'.repeat(40);
    const remoteBundleOps = mockRemoteBundleOps({
      getMirrorBranchSha: vi.fn(async () => prevSha),
      repoExists: vi.fn(async () => true),
      fetchBundleIntoMirror: vi.fn(async () => {
        throw new RemoteGitCommandError('git fetch bundle into mirror did not complete (transport/execution failure)', {
          transportFailure: true,
        });
      }),
      cleanup: vi.fn(async () => {
        throw new Error('rm -f: connection lost');
      }),
    });
    const service = new FetchDistributionService(mockHubRepoCache(), remoteBundleOps, mockSftpService(), mockDistRepo());
    const result = await service.distribute(makeParams());
    expect(result.status).toBe('failed');
    expect(result.error).toContain('transport/execution failure');
    expect(result.error).not.toContain('rm -f');
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
      await flushAsync();

      const second = service.distribute(makeParams());
      await flushAsync();

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
      // (The inner repoHash-keyed lock added for Issue #87 review finding 1
      // adds a couple of extra microtask hops via KeyedMutex's own promise
      // chaining before `a` reaches its upload call, hence more ticks than
      // the bare number of `await` statements in the production code path.)
      const a = service.distribute(makeParams({ repositoryId: 1 }));
      await flushAsync();

      const b = service.distribute(makeParams({ repositoryId: 2 }));
      await flushAsync();

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

    // Issue #87 review, fifth pass, Important finding 1: `server.name` is a
    // logical registration a user created — two DIFFERENT server rows can
    // resolve to the SAME `sshHost` + `homeDir`, in which case they point at
    // the exact same on-disk mirror. The outer lock key must therefore be
    // built from `sshHost` + `homeDir` + `repoHash`, not `server.name`, so
    // such rows still serialize against each other.
    it('serializes calls for two differently-named servers that resolve to the same sshHost and homeDir', async () => {
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

      // Same sshHost + same resolved homeDir for both rows (mockRemoteBundleOps
      // resolves homeDir to a fixed value regardless of the transport passed
      // in), but distinct server names — the two rows are registered
      // separately in the DB, yet describe the same physical machine/account.
      const service = new FetchDistributionService(mockHubRepoCache(), mockRemoteBundleOps(), sftpService as any, mockDistRepo());

      const a = service.distribute(makeParams({ server: makeServer({ name: 'alias-a', sshHost: 'user@shared-host' }) }));
      await flushAsync();

      const b = service.distribute(makeParams({ server: makeServer({ name: 'alias-b', sshHost: 'user@shared-host' }) }));
      await flushAsync();

      // `b` must not have started yet — it is queued behind `a` because both
      // resolve to the same sshHost+homeDir mirror, regardless of server name.
      expect(order).toEqual(['a-start']);

      releaseA();
      await Promise.all([a, b]);
      expect(order).toEqual(['a-start', 'a-end', 'b-start']);
    });

    it('does not serialize two servers with different sshHost (distinct mirrors, even with the same resolved homeDir)', async () => {
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

      const a = service.distribute(makeParams({ server: makeServer({ name: 'server-a', sshHost: 'user@host-a' }) }));
      await flushAsync();

      const b = service.distribute(makeParams({ server: makeServer({ name: 'server-b', sshHost: 'user@host-b' }) }));
      await b;

      expect(order).toEqual(['a-start', 'b-start']);

      releaseA();
      await a;
      expect(order).toEqual(['a-start', 'b-start', 'a-end']);
    });

    // Issue #87 review finding (Important 1, forge/87-mirror follow-up):
    // `this.mutex` (outer) is keyed `${server.name}:${repoHash}`, so it
    // does NOT serialize two DIFFERENT servers distributing the SAME repo
    // — but `HubRepoCache` (the resource `ensureFetched`/`createBundle`
    // actually touch) is shared across every server, keyed by repoHash
    // alone. Without the inner `hubCacheMutex`, server-b's `ensureFetched`
    // could run (and advance the shared cache's ref) while server-a's own
    // bundle build is mid-flight, so server-a's later `createBundle` would
    // read content that doesn't match the sha server-a already captured
    // and is about to report/record.
    it('serializes hub-cache access (ensureFetched + createBundle) across two different servers distributing the same repo', async () => {
      const order: string[] = [];
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      const hubRepoCache = {
        ensureFetched: vi.fn(() => {
          order.push('ensureFetched');
          return sha;
        }),
        createBundle: vi.fn(() => {
          order.push('createBundle');
          return { bundlePath: '/tmp/test.bundle', headSha: sha };
        }),
      } as any;

      const remoteBundleOps = mockRemoteBundleOps({
        // No prerequisite for either server -> both always deliver a full
        // bundle (never `already_current`), so both reach `createBundle`.
        getMirrorBranchSha: vi.fn(async () => null),
        repoExists: vi.fn(async () => false),
      });

      let uploadCount = 0;
      const sftpService = {
        upload: vi.fn(async () => {
          uploadCount += 1;
          if (uploadCount === 1) {
            order.push('server-a-upload-start');
            await firstGate;
            order.push('server-a-upload-end');
          } else {
            order.push('server-b-upload-start');
          }
        }),
      };

      const service = new FetchDistributionService(hubRepoCache, remoteBundleOps, sftpService as any, mockDistRepo());

      const a = service.distribute(makeParams({ server: makeServer({ name: 'server-a', sshHost: 'user@host-a' }) }));
      await flushAsync();

      const b = service.distribute(makeParams({ server: makeServer({ name: 'server-b', sshHost: 'user@host-b' }) }));
      await flushAsync();

      // server-b's ensureFetched/createBundle pair has ALREADY run by now,
      // even though server-a's SFTP upload is still blocked on `firstGate`
      // (Issue #87 third-party review, Important finding 3, second pass):
      // the hub-cache lock is only held across the read-head+build-bundle
      // step, not across the transfer, so it was free again the moment
      // server-a's own `createBundle` returned — long before server-a's
      // upload (and thus its whole `distribute()` call) finishes. Server-b's
      // upload has also already run to completion (the mock does not block
      // the second caller), proving a slow/unreachable server-a transfer
      // does NOT block server-b's distribution of the same repository.
      expect(order).toEqual([
        'ensureFetched', 'createBundle', 'server-a-upload-start',
        'ensureFetched', 'createBundle', 'server-b-upload-start',
      ]);

      releaseFirst();
      const [ra, rb] = await Promise.all([a, b]);

      // The two servers' hub-cache BUILD steps never interleave with each
      // other — each server's ensureFetched+createBundle pair still
      // completes as one unit before the other server's pair begins — but
      // server-a's upload finishing is the LAST thing in the order, after
      // both servers' hub-cache work and server-b's own upload.
      expect(order).toEqual([
        'ensureFetched', 'createBundle', 'server-a-upload-start',
        'ensureFetched', 'createBundle', 'server-b-upload-start',
        'server-a-upload-end',
      ]);
      expect(ra.status).toBe('distributed');
      expect(rb.status).toBe('distributed');
    });

    // Issue #87 third-party review, third pass, Minor finding: reading the
    // mirror's branch sha (`RemoteBundleOps.getMirrorBranchSha`) is a
    // remote round trip to a SPECIFIC server, not a hub-cache operation —
    // it must NOT be made while holding `hubCacheMutex`, or a slow/
    // unreachable server-a would block server-b's distribution of the SAME
    // repository even though the two servers' mirrors are entirely
    // independent and don't share anything `hubCacheMutex` protects.
    it('does not hold hubCacheMutex while reading a mirror branch sha, so a slow getMirrorBranchSha on one server does not block another server distributing the same repo', async () => {
      const order: string[] = [];
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });

      const hubRepoCache = mockHubRepoCache({
        ensureFetched: vi.fn(() => {
          order.push('ensureFetched');
          return sha;
        }),
        createBundle: vi.fn(() => {
          order.push('createBundle');
          return { bundlePath: '/tmp/test.bundle', headSha: sha };
        }),
      });

      let readCount = 0;
      const remoteBundleOps = mockRemoteBundleOps({
        getMirrorBranchSha: vi.fn(async () => {
          readCount += 1;
          if (readCount === 1) {
            order.push('server-a-mirror-read-start');
            await firstGate;
            order.push('server-a-mirror-read-end');
          } else {
            order.push('server-b-mirror-read');
          }
          return null;
        }),
        repoExists: vi.fn(async () => false),
      });

      const sftpService = {
        upload: vi.fn(async () => {
          order.push('upload');
        }),
      };

      const service = new FetchDistributionService(hubRepoCache, remoteBundleOps, sftpService as any, mockDistRepo());

      const a = service.distribute(makeParams({ server: makeServer({ name: 'server-a', sshHost: 'user@host-a' }) }));
      await flushAsync();

      const b = service.distribute(makeParams({ server: makeServer({ name: 'server-b', sshHost: 'user@host-b' }) }));
      await flushAsync();

      // server-b's mirror read, hub-cache read, bundle build, AND upload
      // have all already completed while server-a is still stuck reading
      // its own mirror's sha — proving that read is not gated by
      // hubCacheMutex (nor by the outer per-server mutex, which only
      // serializes calls for the SAME server).
      expect(order).toEqual([
        'server-a-mirror-read-start',
        'server-b-mirror-read', 'ensureFetched', 'createBundle', 'upload',
      ]);

      releaseFirst();
      const [ra, rb] = await Promise.all([a, b]);

      expect(order).toEqual([
        'server-a-mirror-read-start',
        'server-b-mirror-read', 'ensureFetched', 'createBundle', 'upload',
        'server-a-mirror-read-end', 'ensureFetched', 'createBundle', 'upload',
      ]);
      expect(ra.status).toBe('distributed');
      expect(rb.status).toBe('distributed');
    });

    // Issue #87 review finding (Important 3, forge/87-mirror follow-up):
    // when the incremental transfer fails and delivery falls back to a full
    // bundle, the fallback must re-read the hub cache's CURRENT head (which
    // may have moved since the incremental attempt was built) rather than
    // reusing the earlier, possibly now-stale head — and the sha reported
    // back must correspond to the bundle actually delivered (the fallback's
    // head), never the original incremental attempt's head.
    it('reports the fallback full bundle\'s own head sha, not the original incremental attempt\'s, when the cache head moved in between', async () => {
      const prevSha = 'b'.repeat(40);
      const incrementalHeadSha = sha;
      const advancedHeadSha = 'd'.repeat(40);

      let ensureFetchedCalls = 0;
      const hubRepoCache = {
        ensureFetched: vi.fn(() => {
          ensureFetchedCalls += 1;
          // Simulate another distribution advancing the shared cache between
          // the incremental attempt and the full-bundle fallback.
          return ensureFetchedCalls === 1 ? incrementalHeadSha : advancedHeadSha;
        }),
        createBundle: vi.fn((_identity: unknown, _branch: string, sinceCommit?: string) => {
          if (sinceCommit) {
            return { bundlePath: '/tmp/incremental.bundle', headSha: incrementalHeadSha };
          }
          // Full bundle (no sinceCommit): reflects whatever head was current
          // at the time it was actually built — the fallback rebuilds AFTER
          // the second `ensureFetched()` above, so it must carry the
          // advanced head, not the original incremental one.
          return { bundlePath: '/tmp/full.bundle', headSha: advancedHeadSha };
        }),
      } as any;

      const remoteBundleOps = mockRemoteBundleOps({
        getMirrorBranchSha: vi.fn(async () => prevSha),
        repoExists: vi.fn(async () => true),
        fetchBundleIntoMirror: vi.fn()
          .mockRejectedValueOnce(new Error('git fetch bundle into mirror failed: fatal: rejected'))
          .mockResolvedValueOnce(undefined),
      });
      const distRepo = mockDistRepo();
      const service = new FetchDistributionService(hubRepoCache, remoteBundleOps, mockSftpService(), distRepo);

      const result = await service.distribute(makeParams());

      expect(result.status).toBe('distributed');
      expect(result.bundleType).toBe('full');
      expect(result.sha).toBe(advancedHeadSha);
      expect(distRepo.upsert).toHaveBeenCalledWith('iso-server', 1, advancedHeadSha, 'full');
    });
  });
});

// Issue #87 review, 8th pass, Important finding 2: `this.mutex` (outer)
// serializes by mirror identity (`hostIdentity:homeDir:repoHash`), but
// `ensureWorkingDir()` also clones/fetches/detaches/updates refs in
// `workingDir` — a path not 1:1 with the mirror. Two distributions for
// DIFFERENT repos (different repoHash, so different outer-mutex keys, so
// they run concurrently up to that point) can still target the SAME
// `workingDir` (operator misconfiguration, or two registrations sharing a
// filesystem path) — without a second lock keyed by the actual working
// directory, their clone/fetch/detach/ref-update sequences could interleave
// and corrupt the checkout.
describe('FetchDistributionService workingDir serialization (Issue #87 review, 8th pass, Important finding 2)', () => {
  it('serializes ensureWorkingDir for two distributions that target the same workingDir, even though they use different repositories (different mirrors)', async () => {
    const order: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    let call = 0;
    const remoteBundleOps = mockRemoteBundleOps({
      // Mirror already at the hub cache's head, so both calls take the
      // `already_current` path and go straight into `ensureWorkingDir()`
      // without ever touching SFTP — isolating the assertion to the
      // workingDir lock alone.
      getMirrorBranchSha: vi.fn(async () => sha),
      repoExists: vi.fn(async () => true),
      fetchWorkingDirFromMirror: vi.fn(async () => {
        call += 1;
        if (call === 1) {
          order.push('a-start');
          await gateA;
          order.push('a-end');
        } else {
          order.push('b-start');
        }
      }),
    });

    const service = new FetchDistributionService(mockHubRepoCache(), remoteBundleOps, mockSftpService(), mockDistRepo());
    const otherIdentity: CanonicalRepositoryIdentity = {
      ...identity,
      repo: 'other-repo',
      httpsUrl: 'https://github.com/owner/other-repo.git',
    };
    const sharedWorkingDir = '/home/agent/shared-checkout';

    const a = service.distribute(makeParams({ repositoryId: 1, repoIdentity: identity, workingDir: sharedWorkingDir }));
    await flushAsync();

    // Different repoIdentity -> different repoHash -> different outer
    // mutex key, so `b` is NOT queued behind `a` by the mirror lock. It
    // must still be blocked from starting its own `ensureWorkingDir()`
    // step until `a`'s finishes, because both target the same workingDir.
    const b = service.distribute(makeParams({ repositoryId: 2, repoIdentity: otherIdentity, workingDir: sharedWorkingDir }));
    await flushAsync();

    expect(order).toEqual(['a-start']);

    releaseA();
    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
  });

  it('does not serialize ensureWorkingDir for two distributions that target different workingDirs', async () => {
    const order: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    let call = 0;
    const remoteBundleOps = mockRemoteBundleOps({
      getMirrorBranchSha: vi.fn(async () => sha),
      repoExists: vi.fn(async () => true),
      fetchWorkingDirFromMirror: vi.fn(async () => {
        call += 1;
        if (call === 1) {
          order.push('a-start');
          await gateA;
          order.push('a-end');
        } else {
          order.push('b-start');
        }
      }),
    });

    const service = new FetchDistributionService(mockHubRepoCache(), remoteBundleOps, mockSftpService(), mockDistRepo());
    const otherIdentity: CanonicalRepositoryIdentity = {
      ...identity,
      repo: 'other-repo',
      httpsUrl: 'https://github.com/owner/other-repo.git',
    };

    const a = service.distribute(makeParams({ repositoryId: 1, repoIdentity: identity, workingDir: '/home/agent/checkout-a' }));
    await flushAsync();

    const b = service.distribute(makeParams({ repositoryId: 2, repoIdentity: otherIdentity, workingDir: '/home/agent/checkout-b' }));
    await b;

    // `b` must have proceeded immediately, without waiting for `a`.
    expect(order).toEqual(['a-start', 'b-start']);

    releaseA();
    await a;
    expect(order).toEqual(['a-start', 'b-start', 'a-end']);
  });

  it('treats a trailing-slash spelling of the same workingDir as the same lock key', async () => {
    const order: string[] = [];
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    let call = 0;
    const remoteBundleOps = mockRemoteBundleOps({
      getMirrorBranchSha: vi.fn(async () => sha),
      repoExists: vi.fn(async () => true),
      fetchWorkingDirFromMirror: vi.fn(async () => {
        call += 1;
        if (call === 1) {
          order.push('a-start');
          await gateA;
          order.push('a-end');
        } else {
          order.push('b-start');
        }
      }),
    });

    const service = new FetchDistributionService(mockHubRepoCache(), remoteBundleOps, mockSftpService(), mockDistRepo());
    const otherIdentity: CanonicalRepositoryIdentity = {
      ...identity,
      repo: 'other-repo',
      httpsUrl: 'https://github.com/owner/other-repo.git',
    };

    const a = service.distribute(makeParams({ repositoryId: 1, repoIdentity: identity, workingDir: '/home/agent/shared-checkout' }));
    await flushAsync();

    const b = service.distribute(makeParams({ repositoryId: 2, repoIdentity: otherIdentity, workingDir: '/home/agent/shared-checkout/' }));
    await flushAsync();

    expect(order).toEqual(['a-start']);

    releaseA();
    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
  });
});

// Issue #87 review, 6th pass, Important finding 3: the outer lock's key
// used to be built from the RAW `sshHost` string. SFTP resolves `sshHost`
// through SSH config/aliasing before connecting, so two spellings that
// resolve to the exact same host/port/username connect to (and write) the
// exact same on-disk mirror while taking DIFFERENT raw-string lock keys —
// letting two forced `fetch --atomic` calls race the same mirror. Passing a
// `sshHostResolver` (the optional 5th constructor arg) normalizes the key
// through resolution first.
describe('FetchDistributionService lock key host normalization (Issue #87 review, 6th pass, Important finding 3)', () => {
  // Minimal stand-in for SshClient.resolveHost: parses `user@host[:port]`,
  // defaulting the port to 22 when omitted — enough to prove `host` and
  // `host:22` collapse to the same identity without pulling in the real
  // SSH/config-file stack.
  function fakeResolveHost(hostStr: string): { host: string; port: number; username: string } {
    const [username, rest] = hostStr.split('@');
    const [host, portStr] = rest.split(':');
    return { host, port: portStr ? parseInt(portStr, 10) : 22, username };
  }
  const sshHostResolver = { resolveHost: vi.fn(fakeResolveHost) };

  it('serializes two distribute() calls whose sshHost strings differ but resolve to the same host/port/username', async () => {
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

    const service = new FetchDistributionService(
      mockHubRepoCache(), mockRemoteBundleOps(), sftpService as any, mockDistRepo(), sshHostResolver,
    );

    // 'user@host' (implicit port 22) and 'user@host:22' (explicit) resolve
    // to the identical { host: 'host', port: 22, username: 'user' } triple.
    const a = service.distribute(makeParams({ server: makeServer({ name: 'alias-a', sshHost: 'user@host' }) }));
    await flushAsync();

    const b = service.distribute(makeParams({ server: makeServer({ name: 'alias-b', sshHost: 'user@host:22' }) }));
    await flushAsync();

    // `b` must not have started yet — it is queued behind `a` because both
    // resolve to the same normalized host identity.
    expect(order).toEqual(['a-start']);

    releaseA();
    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
  });

  it('does not serialize two distribute() calls whose sshHost strings resolve to different hosts', async () => {
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

    const service = new FetchDistributionService(
      mockHubRepoCache(), mockRemoteBundleOps(), sftpService as any, mockDistRepo(), sshHostResolver,
    );

    const a = service.distribute(makeParams({ server: makeServer({ name: 'server-a', sshHost: 'user@host-a' }) }));
    await flushAsync();

    const b = service.distribute(makeParams({ server: makeServer({ name: 'server-b', sshHost: 'user@host-b' }) }));
    await b;

    expect(order).toEqual(['a-start', 'b-start']);

    releaseA();
    await a;
    expect(order).toEqual(['a-start', 'b-start', 'a-end']);
  });

  it('falls back to the raw sshHost string (still serializing same-spelling calls) when no resolver is provided', async () => {
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

    // No 5th constructor arg — mirrors the pre-fix behavior / any caller
    // (e.g. a test) that doesn't care about alias collapsing.
    const service = new FetchDistributionService(mockHubRepoCache(), mockRemoteBundleOps(), sftpService as any, mockDistRepo());

    const a = service.distribute(makeParams({ server: makeServer({ name: 'server-a', sshHost: 'user@same-host' }) }));
    await flushAsync();

    const b = service.distribute(makeParams({ server: makeServer({ name: 'server-b', sshHost: 'user@same-host' }) }));
    await flushAsync();

    expect(order).toEqual(['a-start']);

    releaseA();
    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start']);
  });
});

describe('FetchDistributionService workingDir repoHash stamp verification (Issue #87 third-party review, 10th round, Important finding 2)', () => {
  const repoHash = computeRepoHash(identity);
  const otherIdentity: CanonicalRepositoryIdentity = {
    provider: 'github',
    host: 'github.com',
    owner: 'someone-else',
    repo: 'other-repo',
    httpsUrl: 'https://github.com/someone-else/other-repo.git',
  };

  it('fails fast when the existing workingDir is stamped for a different repository', async () => {
    const remoteBundleOps = mockRemoteBundleOps({
      getMirrorBranchSha: vi.fn(async () => sha),
      repoExists: vi.fn(async () => true),
      getStampedRepoHash: vi.fn(async () => computeRepoHash(otherIdentity)),
    });
    const service = new FetchDistributionService(mockHubRepoCache(), remoteBundleOps, mockSftpService(), mockDistRepo());
    const result = await service.distribute(makeParams());
    expect(result.status).toBe('failed');
    expect((result as any).error).toMatch(/different repository/);
    // Must fail BEFORE mutating the mismatched checkout.
    expect(remoteBundleOps.fetchWorkingDirFromMirror).not.toHaveBeenCalled();
    expect(remoteBundleOps.stampRepoHash).not.toHaveBeenCalled();
  });

  it('skips verification and back-fills the stamp for a pre-existing, never-stamped workingDir', async () => {
    const remoteBundleOps = mockRemoteBundleOps({
      getMirrorBranchSha: vi.fn(async () => sha),
      repoExists: vi.fn(async () => true),
      getStampedRepoHash: vi.fn(async () => null),
    });
    const service = new FetchDistributionService(mockHubRepoCache(), remoteBundleOps, mockSftpService(), mockDistRepo());
    const result = await service.distribute(makeParams());
    expect(result.status).toBe('already_current');
    // Back-compat: no stamp existed, so distribution still proceeds normally...
    expect(remoteBundleOps.fetchWorkingDirFromMirror).toHaveBeenCalled();
    // ...and the stamp is written so the NEXT distribution is protected.
    expect(remoteBundleOps.stampRepoHash).toHaveBeenCalledWith({}, '/home/agent/repo', repoHash);
  });

  it('proceeds normally when the existing workingDir is stamped for the same repository', async () => {
    const remoteBundleOps = mockRemoteBundleOps({
      getMirrorBranchSha: vi.fn(async () => sha),
      repoExists: vi.fn(async () => true),
      getStampedRepoHash: vi.fn(async () => repoHash),
    });
    const service = new FetchDistributionService(mockHubRepoCache(), remoteBundleOps, mockSftpService(), mockDistRepo());
    const result = await service.distribute(makeParams());
    expect(result.status).toBe('already_current');
    expect(remoteBundleOps.fetchWorkingDirFromMirror).toHaveBeenCalled();
    // Already stamped correctly — no need to re-write it.
    expect(remoteBundleOps.stampRepoHash).not.toHaveBeenCalled();
  });

  it('stamps a brand-new clone (workingDir did not exist)', async () => {
    const remoteBundleOps = mockRemoteBundleOps({
      getMirrorBranchSha: vi.fn(async () => null),
      repoExists: vi.fn(async () => false),
    });
    const service = new FetchDistributionService(mockHubRepoCache(), remoteBundleOps, mockSftpService(), mockDistRepo());
    const result = await service.distribute(makeParams());
    expect(result.status).toBe('distributed');
    expect(remoteBundleOps.cloneWorkingDirFromMirror).toHaveBeenCalled();
    expect(remoteBundleOps.getStampedRepoHash).not.toHaveBeenCalled();
    expect(remoteBundleOps.stampRepoHash).toHaveBeenCalledWith({}, '/home/agent/repo', repoHash);
  });
});

describe('FetchDistributionService unstamped-workingDir identity verification (Issue #87 third-party review, 11th round, Important finding 2)', () => {
  const repoHash = computeRepoHash(identity);

  it('origin matches the distributed repository: stamps BEFORE mutating, then proceeds normally', async () => {
    const remoteBundleOps = mockRemoteBundleOps({
      getMirrorBranchSha: vi.fn(async () => sha),
      repoExists: vi.fn(async () => true),
      getStampedRepoHash: vi.fn(async () => null),
      getOriginUrl: vi.fn(async () => identity.httpsUrl),
    });
    const service = new FetchDistributionService(mockHubRepoCache(), remoteBundleOps, mockSftpService(), mockDistRepo());
    const result = await service.distribute(makeParams());

    expect(result.status).toBe('already_current');
    expect(remoteBundleOps.stampRepoHash).toHaveBeenCalledWith({}, '/home/agent/repo', repoHash);
    expect(remoteBundleOps.fetchWorkingDirFromMirror).toHaveBeenCalled();

    // Stamp must be written BEFORE the fetch that mutates the checkout —
    // not merely called at all.
    const stampOrder = remoteBundleOps.stampRepoHash.mock.invocationCallOrder[0];
    const fetchOrder = remoteBundleOps.fetchWorkingDirFromMirror.mock.invocationCallOrder[0];
    expect(stampOrder).toBeLessThan(fetchOrder);
  });

  it('origin identifies a DIFFERENT real repository: fails fast and leaves workingDir untouched', async () => {
    const remoteBundleOps = mockRemoteBundleOps({
      getMirrorBranchSha: vi.fn(async () => sha),
      repoExists: vi.fn(async () => true),
      getStampedRepoHash: vi.fn(async () => null),
      getOriginUrl: vi.fn(async () => 'https://github.com/someone-else/other-repo.git'),
    });
    const service = new FetchDistributionService(mockHubRepoCache(), remoteBundleOps, mockSftpService(), mockDistRepo());
    const result = await service.distribute(makeParams());

    expect(result.status).toBe('failed');
    expect((result as any).error).toMatch(/different repository/);
    // No mutation of any kind happened.
    expect(remoteBundleOps.fetchWorkingDirFromMirror).not.toHaveBeenCalled();
    expect(remoteBundleOps.stampRepoHash).not.toHaveBeenCalled();
    expect(remoteBundleOps.setDummyOrigin).not.toHaveBeenCalled();
  });

  it('origin is the dummy sentinel (pre-existing AZITO-managed checkout): adopts it with a warning', async () => {
    const remoteBundleOps = mockRemoteBundleOps({
      getMirrorBranchSha: vi.fn(async () => sha),
      repoExists: vi.fn(async () => true),
      getStampedRepoHash: vi.fn(async () => null),
      getOriginUrl: vi.fn(async () => 'https://azito-isolated-no-direct-access.invalid/repo.git'),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const service = new FetchDistributionService(mockHubRepoCache(), remoteBundleOps, mockSftpService(), mockDistRepo());
      const result = await service.distribute(makeParams());

      expect(result.status).toBe('already_current');
      expect(remoteBundleOps.stampRepoHash).toHaveBeenCalledWith({}, '/home/agent/repo', repoHash);
      expect(remoteBundleOps.fetchWorkingDirFromMirror).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('origin is unset (pre-existing AZITO-managed checkout): adopts it with a warning', async () => {
    const remoteBundleOps = mockRemoteBundleOps({
      getMirrorBranchSha: vi.fn(async () => sha),
      repoExists: vi.fn(async () => true),
      getStampedRepoHash: vi.fn(async () => null),
      getOriginUrl: vi.fn(async () => null),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const service = new FetchDistributionService(mockHubRepoCache(), remoteBundleOps, mockSftpService(), mockDistRepo());
      const result = await service.distribute(makeParams());

      expect(result.status).toBe('already_current');
      expect(remoteBundleOps.stampRepoHash).toHaveBeenCalledWith({}, '/home/agent/repo', repoHash);
      expect(remoteBundleOps.fetchWorkingDirFromMirror).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
