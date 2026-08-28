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
type PrepResult =
  | { kind: 'current'; headSha: string }
  | { kind: 'bundle'; attemptType: BundleType; bundleResult: BundleResult };

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
  // cache's `refs/heads/<branch>` to B; call A then reads the NOW-current
  // ref and bundles B's content — while A still reports/records sha A. The
  // bundle actually delivered and the sha recorded for it silently
  // diverge (Issue #87 third-party review, Important finding).
  //
  // Held ONLY across the read-head + build-first-bundle step
  // (`prepareBundle()`, called from `distributeUnlocked()`) and, on the
  // incremental->full fallback path, across re-reading the head and
  // building the fallback full bundle (`deliverToMirror()`'s fallback
  // branch) — never across the SFTP upload / remote verify / remote fetch
  // that follows (Issue #87 third-party review, Important finding 3, second
  // pass: a slow/unreachable server used to hold this lock for the whole
  // transfer, blocking every OTHER server's distribution of the same
  // repository for however long that transfer took, even though each
  // server's mirror is independent and the bundle file itself is already
  // complete and immutable by the time the transfer starts). Each critical
  // section still reads the head and builds its bundle from that exact same
  // snapshot without ever splitting a single "read then build" step across
  // two acquisitions, which is the part that actually needs the lock.
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

      // Deliberately read OUTSIDE `hubCacheMutex` (Issue #87 third-party
      // review, third pass, Minor finding): this is a remote round trip to
      // THIS server (can be slow or hang on an unreachable/laggy server),
      // while the mutex's whole purpose (see its doc comment above) is to
      // protect the hub's own local repo-cache directory, which every OTHER
      // server's distribution of the SAME repository also needs. Holding
      // the lock across this remote call would let one slow server block
      // every other server's distribution of the same repo. The mirror's
      // SHA is independent of the hub cache's state — it only describes
      // what THIS server's mirror has already received — so it's safe to
      // read before acquiring the lock and hand the snapshot in.
      const mirrorSha = await this.remoteBundleOps.getMirrorBranchSha(transport, mirrorDir, branch);

      // See `hubCacheMutex`'s doc comment above for why the head-read and
      // the first bundle build must be one uninterrupted critical section
      // keyed by `repoHash` alone.
      const prep = await this.hubCacheMutex.withLock(repoHash, () =>
        this.prepareBundle(repoIdentity, token, branch, mirrorSha));

      if (prep.kind === 'current') {
        // workingDir may still be missing or stale (e.g. it was deleted
        // separately from the mirror), so it's ensured even when the
        // transfer itself was skipped.
        const localBranchSynced = await this.ensureWorkingDir(transport, mirrorDir, workingDir, branch);
        return { status: 'already_current', sha: prep.headSha, localBranchSynced };
      }

      // Upload/verify/apply runs OUTSIDE `hubCacheMutex` — see the lock's
      // doc comment above for why.
      const delivered = await this.deliverToMirror(transport, sshHost, repoHash, repoIdentity, branch, mirrorDir, prep);

      const localBranchSynced = await this.ensureWorkingDir(transport, mirrorDir, workingDir, branch);

      this.distributionStateRepo.upsert(server.name, repositoryId, delivered.headSha, delivered.bundleType);

      return { status: 'distributed', sha: delivered.headSha, bundleType: delivered.bundleType, localBranchSynced };
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Reads the hub cache's current head for `branch` and compares it against
   * `mirrorSha` — the mirror's ACTUAL ref, read by the caller BEFORE this
   * method was called (never the DB's `last_distributed_sha` — Issue #87:
   * DB and mirror can drift, e.g. after a force-push or a manually-wiped
   * mirror, and a DB-derived prerequisite made that drift permanent).
   * `mirrorSha` itself is a snapshot taken outside `hubCacheMutex` (see the
   * lock-acquisition comment at this method's call site) — it describes a
   * different server's independent state, not anything this lock protects,
   * so reading it earlier/outside is safe; the only thing that MUST stay
   * inside one uninterrupted critical section keyed by `repoHash` is the
   * hub-cache head-read (`ensureFetched` below) together with the first
   * bundle build off of it (see `hubCacheMutex`'s doc comment for why THAT
   * pair cannot be split across two separate lock acquisitions). When
   * `mirrorSha` already matches the freshly-read hub-cache head, no bundle
   * is built. Otherwise builds the FIRST bundle attempt (incremental off
   * `mirrorSha` when non-null, full otherwise) from that exact same cache
   * snapshot.
   */
  private async prepareBundle(
    repoIdentity: CanonicalRepositoryIdentity,
    token: string,
    branch: string,
    mirrorSha: string | null,
  ): Promise<PrepResult> {
    const headSha = this.hubRepoCache.ensureFetched(repoIdentity, token, branch);

    if (mirrorSha === headSha) {
      return { kind: 'current', headSha };
    }

    const incremental = mirrorSha ? this.tryCreateBundle(repoIdentity, branch, mirrorSha) : null;
    if (incremental) {
      return { kind: 'bundle', attemptType: 'incremental', bundleResult: incremental };
    }
    return { kind: 'bundle', attemptType: 'full', bundleResult: this.hubRepoCache.createBundle(repoIdentity, branch) };
  }

  /**
   * Transfers the bundle `prepareBundle()` already built (SFTP upload +
   * remote verify + remote fetch into the mirror), deliberately outside any
   * lock — see `hubCacheMutex`'s doc comment for why. If that transfer fails
   * and the attempt was incremental, falls back to full exactly once: the
   * fallback re-acquires `hubCacheMutex`, re-reads the hub cache's CURRENT
   * head (which may have advanced since `prepareBundle` ran — a concurrent
   * distribution for a different server could have moved it while this
   * transfer was in flight) and builds a full bundle from THAT head, then
   * retries the transfer with it, again outside the lock. The sha/bundleType
   * this returns always describes the bundle actually delivered — never the
   * earlier, possibly now-superseded incremental attempt (Issue #87
   * third-party review, Important finding 3).
   */
  private async deliverToMirror(
    transport: IServerTransport,
    sshHost: string,
    repoHash: string,
    repoIdentity: CanonicalRepositoryIdentity,
    branch: string,
    mirrorDir: string,
    prep: { attemptType: BundleType; bundleResult: BundleResult },
  ): Promise<{ headSha: string; bundleType: BundleType }> {
    const { attemptType, bundleResult } = prep;

    try {
      await this.uploadVerifyApply(transport, sshHost, mirrorDir, branch, bundleResult);
      return { headSha: bundleResult.headSha, bundleType: attemptType };
    } catch (err) {
      if (attemptType === 'full') throw err; // already the last attempt — no further fallback
    } finally {
      try { fs.unlinkSync(bundleResult.bundlePath); } catch {}
    }

    // Incremental transfer failed — fall back to full, off a freshly
    // re-read cache head (see this method's doc comment).
    const fullBundle = await this.hubCacheMutex.withLock(repoHash, async () => this.hubRepoCache.createBundle(repoIdentity, branch));
    try {
      await this.uploadVerifyApply(transport, sshHost, mirrorDir, branch, fullBundle);
      return { headSha: fullBundle.headSha, bundleType: 'full' };
    } finally {
      try { fs.unlinkSync(fullBundle.bundlePath); } catch {}
    }
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

  /**
   * Returns whether `workingDir`'s LOCAL branch ref was successfully synced
   * to the freshly distributed tracking ref (see
   * `RemoteBundleOps.syncLocalBranchToTracking`'s doc comment) — callers use
   * this, together with whether `task.branch` names the distributed branch,
   * to decide whether a sync failure here can actually be reached by stale
   * content (Issue #87 review, forge/87-mirror follow-up, Important finding
   * 1). `false` is returned rather than thrown; the caller decides whether
   * it matters.
   */
  private async ensureWorkingDir(transport: IServerTransport, mirrorDir: string, workingDir: string, branch: string): Promise<boolean> {
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
    // doc comment for the corrected reasoning — it is NOT a universal
    // backstop, so the boolean result is surfaced to the caller, which
    // decides whether this specific failure needs to fail the whole task).
    const branchSynced = await this.remoteBundleOps.syncLocalBranchToTracking(transport, workingDir, branch);
    if (!branchSynced) {
      console.warn(`[FetchDistributionService] syncLocalBranchToTracking failed for branch "${branch}" in ${workingDir} (see RemoteBundleOps.syncLocalBranchToTracking's doc comment; caller decides whether this is fatal)`);
    }
    // origin policy is unchanged by this refactor — still a dummy URL, kept
    // separate from the mirror-path update route above.
    await this.remoteBundleOps.setDummyOrigin(transport, workingDir);
    return branchSynced;
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
