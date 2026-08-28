import * as crypto from 'crypto';
import * as fs from 'fs';
import type { IServerTransport } from '../../servers/transport/ServerTransport';
import type { CanonicalRepositoryIdentity } from '../resolveCanonicalRepositoryIdentity';
import type { SftpService } from '../../servers/ssh/SftpService';
import { KeyedMutex } from '../../../shared/keyedMutex';
import type { HubRepoCache } from './HubRepoCache';
import type { RemoteBundleOps } from './RemoteBundleOps';
import { computeRepoHash } from './repoHash';
import type { IDistributionStateRepository, FetchDistributionParams, FetchDistributionResult } from './types';

type BundleType = 'full' | 'incremental';
type BundleResult = { bundlePath: string; headSha: string };

export class FetchDistributionService {
  // Serializes `distribute()` runs per `${server.name}:${computeRepoHash(repoIdentity)}`
  // so two concurrent distributions that write the same shared mirror can't
  // race against each other (both would query its refs, build a bundle off
  // the same prerequisite, and could interleave their `fetch --atomic` into
  // the mirror). The key must match the mirror's own identity — the mirror
  // path is derived from `computeRepoHash(repoIdentity)`, not from
  // `repositoryId` (a `project_repositories` row id), and distinct
  // repositoryId rows can point at the same canonical repository (Issue #87
  // review finding). The hub runs as a single process, so an in-memory
  // promise chain (no DB-level lock needed) is sufficient — same pattern as
  // `WindowRotation.ts`'s `runExclusiveForTask`.
  private readonly mutex = new KeyedMutex();

  // Second mutex, keyed by `computeRepoHash(repoIdentity)` ALONE (no server
  // name) — serializes access to the resources `HubRepoCache` actually
  // shares across every server: the one bare repo-cache directory at
  // `repo-cache/<repoHash>` on the hub itself. `this.mutex` above only
  // prevents the SAME server from racing itself; it does nothing for two
  // DIFFERENT servers distributing the SAME repository, which both read
  // and mutate that one shared cache directory. Without this second lock:
  // call A (-> server1) calls `ensureFetched()` and captures headSha=A;
  // call B (-> server2) then runs `ensureFetched()` entirely, advancing the
  // cache's `refs/heads/<branch>` to B; call A then reaches
  // `deliverToMirror()`, whose `createBundle()` reads the NOW-current ref
  // and bundles B's content — while A still reports/records sha A. The
  // bundle actually delivered and the sha recorded for it silently
  // diverge (Issue #87 third-party review, Important finding).
  //
  // Held continuously across `ensureFetched()` AND the whole of
  // `deliverToMirror()` (which is where every `createBundle()` call for
  // this distribution happens, including the incremental->full fallback
  // retry) so the headSha captured up front and the bundle(s) actually
  // built from the cache are always the exact same snapshot — never split
  // across two separate `withLock()` acquisitions, which would reopen the
  // same race for just the fallback path.
  //
  // Lock acquisition order is always OUTER (`this.mutex`, keyed
  // `${server.name}:${repoHash}`, taken by `distribute()`) then INNER
  // (`this.hubCacheMutex`, keyed `repoHash`, taken inside
  // `distributeUnlocked()`) — never the reverse. Nothing in this class ever
  // holds the inner lock while trying to acquire the outer one, so the two
  // can never deadlock against each other.
  private readonly hubCacheMutex = new KeyedMutex();

  constructor(
    private hubRepoCache: HubRepoCache,
    private remoteBundleOps: RemoteBundleOps,
    private sftpService: SftpService,
    private distributionStateRepo: IDistributionStateRepository,
  ) {}

  async distribute(params: FetchDistributionParams): Promise<FetchDistributionResult> {
    const { server, repoIdentity } = params;
    return this.mutex.withLock(`${server.name}:${computeRepoHash(repoIdentity)}`, () => this.distributeUnlocked(params));
  }

  private async distributeUnlocked(params: FetchDistributionParams): Promise<FetchDistributionResult> {
    const { server, transport, repoIdentity, token, branch, workingDir, repositoryId } = params;
    const sshHost = server.sshHost;
    if (!sshHost) {
      return { status: 'failed', error: 'Server has no sshHost configured for SFTP transfer' };
    }

    try {
      const repoHash = computeRepoHash(repoIdentity);
      const homeDir = await this.remoteBundleOps.resolveHomeDir(transport);
      const mirrorDir = this.remoteBundleOps.mirrorDir(homeDir, repoHash);
      await this.remoteBundleOps.ensureMirror(transport, mirrorDir);

      // See `hubCacheMutex`'s doc comment above for why `ensureFetched()`
      // and `deliverToMirror()` (which is where the `createBundle()` calls
      // live) must be one uninterrupted critical section keyed by
      // `repoHash` alone.
      const { headSha, bundleType } = await this.hubCacheMutex.withLock(repoHash, async () => {
        const headSha = this.hubRepoCache.ensureFetched(repoIdentity, token, branch);

        // The mirror's actual refs are the only source of truth for the
        // incremental prerequisite and the already-current check — never the
        // DB's `last_distributed_sha` (Issue #87: DB and mirror can drift,
        // e.g. after a force-push or a manually-wiped mirror, and a DB-derived
        // prerequisite made that drift permanent).
        const mirrorSha = await this.remoteBundleOps.getMirrorBranchSha(transport, mirrorDir, branch);

        if (mirrorSha === headSha) {
          // Transfer can be skipped — nothing further touches the hub cache.
          return { headSha, bundleType: null };
        }

        const bundleType = await this.deliverToMirror(transport, sshHost, repoIdentity, branch, mirrorDir, mirrorSha);
        return { headSha, bundleType };
      });

      if (bundleType === null) {
        // workingDir may still be missing or stale (e.g. it was deleted
        // separately from the mirror), so it's ensured even when the
        // transfer itself was skipped.
        await this.ensureWorkingDir(transport, mirrorDir, workingDir, branch);
        return { status: 'already_current', sha: headSha };
      }

      await this.ensureWorkingDir(transport, mirrorDir, workingDir, branch);

      this.distributionStateRepo.upsert(server.name, repositoryId, headSha, bundleType);

      return { status: 'distributed', sha: headSha, bundleType };
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * bundle を作成して mirror へ届ける。`mirrorSha` があれば増分を試み、増分の
   * verify/fetch が失敗した場合に限り全量へ切り替えて 1 回だけ再試行する
   * （無限ループにはしない）。`mirrorSha` が無ければ最初から全量。
   */
  private async deliverToMirror(
    transport: IServerTransport,
    sshHost: string,
    repoIdentity: CanonicalRepositoryIdentity,
    branch: string,
    mirrorDir: string,
    mirrorSha: string | null,
  ): Promise<BundleType> {
    const attempts: BundleType[] = mirrorSha ? ['incremental', 'full'] : ['full'];

    let lastErr: unknown;
    for (const attemptType of attempts) {
      const bundleResult = attemptType === 'incremental'
        ? this.tryCreateBundle(repoIdentity, branch, mirrorSha as string)
        : this.hubRepoCache.createBundle(repoIdentity, branch);
      if (!bundleResult) continue; // incremental bundle creation failed locally; fall through to full

      try {
        await this.uploadVerifyApply(transport, sshHost, mirrorDir, branch, bundleResult);
        return attemptType;
      } catch (err) {
        lastErr = err;
      } finally {
        try { fs.unlinkSync(bundleResult.bundlePath); } catch {}
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async uploadVerifyApply(
    transport: IServerTransport,
    sshHost: string,
    mirrorDir: string,
    branch: string,
    bundleResult: BundleResult,
  ): Promise<void> {
    const nonce = crypto.randomBytes(8).toString('hex');
    const remoteTmpPath = `/tmp/azito-dist-${nonce}.bundle`;
    try {
      await this.sftpService.upload(sshHost, bundleResult.bundlePath, remoteTmpPath);

      const verified = await this.remoteBundleOps.verify(transport, remoteTmpPath);
      if (!verified) {
        throw new Error('Bundle verification failed on remote');
      }

      // Forced refspec + --atomic: tolerates the mirror's branch having
      // diverged from this bundle's prerequisite (e.g. a concurrent
      // force-push upstream) instead of failing non-fast-forward forever.
      await this.remoteBundleOps.fetchBundleIntoMirror(transport, mirrorDir, remoteTmpPath, branch);
    } finally {
      await this.remoteBundleOps.cleanup(transport, remoteTmpPath);
    }
  }

  private async ensureWorkingDir(transport: IServerTransport, mirrorDir: string, workingDir: string, branch: string): Promise<void> {
    const exists = await this.remoteBundleOps.repoExists(transport, workingDir);
    if (exists) {
      await this.remoteBundleOps.fetchWorkingDirFromMirror(transport, mirrorDir, workingDir, branch);
    } else {
      await this.remoteBundleOps.cloneWorkingDirFromMirror(transport, mirrorDir, workingDir, branch);
    }
    // Detach is applied every time, on both the clone and the fetch path —
    // not just once after clone. If detach alone fails, workingDir/.git
    // already exists, so the next distribution takes the fetch path (via
    // `repoExists` above) and would never retry it otherwise (Issue #87
    // review finding). Idempotent, so re-running it on an already-detached
    // workingDir is a no-op.
    await this.remoteBundleOps.ensureDetachedHead(transport, workingDir);
    // Issue #87 review finding 2: keep workingDir's LOCAL branch ref caught
    // up with the freshly distributed tracking ref, on both the clone and
    // fetch path (same "applied every time, idempotent" reasoning as
    // `ensureDetachedHead` above) — otherwise a task whose `task.branch`
    // names an EXISTING local branch (RemoteWorktreeService's "reuse local
    // branch" path, which never consults baseBranch at all) would silently
    // build from stale content even though distribution just succeeded.
    // Failure is tolerated by design (see syncLocalBranchToTracking's own
    // doc comment for why that can never leave a silent stale-content
    // path), but still surfaced here rather than discarded, so an operator
    // investigating a "distribution succeeded but worktree still stale"
    // report has a lead.
    const branchSynced = await this.remoteBundleOps.syncLocalBranchToTracking(transport, workingDir, branch);
    if (!branchSynced) {
      console.warn(`[FetchDistributionService] syncLocalBranchToTracking failed for branch "${branch}" in ${workingDir} (tolerated — see RemoteBundleOps.syncLocalBranchToTracking's doc comment)`);
    }
    // origin policy is unchanged by this refactor — still a dummy URL, kept
    // separate from the mirror-path update route above.
    await this.remoteBundleOps.setDummyOrigin(transport, workingDir);
  }

  private tryCreateBundle(
    identity: Parameters<HubRepoCache['createBundle']>[0],
    branch: string,
    sinceCommit: string,
  ): ReturnType<HubRepoCache['createBundle']> | null {
    try {
      return this.hubRepoCache.createBundle(identity, branch, sinceCommit);
    } catch {
      return null;
    }
  }
}
