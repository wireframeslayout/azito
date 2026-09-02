import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { IServerTransport } from '../../servers/transport/ServerTransport';
import type { CanonicalRepositoryIdentity } from '../resolveCanonicalRepositoryIdentity';
import type { SftpService } from '../../servers/ssh/SftpService';
import { KeyedMutex } from '../../../shared/keyedMutex';
import type { HubRepoCache } from './HubRepoCache';
import type { RemoteBundleOps } from './RemoteBundleOps';
import { computeRepoHash } from './repoHash';
import { RemoteGitCommandError } from '../execWithSentinel';
import { redactGitUrlCredentials } from '../redactGitUrlCredentials';
import { resolveCanonicalRepositoryIdentity } from '../resolveCanonicalRepositoryIdentity';
import { DUMMY_ORIGIN_URL, type IDistributionStateRepository, type FetchDistributionParams, type FetchDistributionResult } from './types';

type BundleType = 'full' | 'incremental';
type BundleResult = { bundlePath: string; headSha: string };
type PrepResult =
  | { kind: 'current'; headSha: string }
  | { kind: 'bundle'; attemptType: BundleType; bundleResult: BundleResult };

/**
 * Marks a failure that occurred in the SFTP transfer layer itself (upload
 * connect/auth/timeout) rather than in the content of the bundle being
 * delivered. `deliverToMirror()`'s incremental->full fallback exists to
 * route around a bundle whose PREREQUISITE the remote mirror rejected (verify
 * failure) or whose apply the remote mirror rejected (fetch-into-mirror
 * failure) — a full bundle has no prerequisite, so it can succeed where an
 * incremental one didn't. A transfer-layer failure has nothing to do with
 * which bundle was being sent: a server that's unreachable or rejecting auth
 * will fail the SAME way for a full bundle, so falling back just repeats the
 * failure after paying the SFTP client's full timeout a second time (Issue
 * #87 review, fifth pass, Important finding 2). Callers must not
 * string-match error messages to tell the two apart — that's what this type
 * exists to make unnecessary — and must preserve `cause` so the original
 * transfer failure is never lost.
 */
export class BundleTransferError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BundleTransferError';
  }
}

export class FetchDistributionService {
  // Serializes `distribute()` runs per `${resolvedHostIdentity}:${homeDir}:${computeRepoHash(repoIdentity)}`
  // so two concurrent distributions that write the same shared mirror can't
  // race against each other (both would query its refs, build a bundle off
  // the same prerequisite, and could interleave their `fetch --atomic` into
  // the mirror). The key must match the mirror's own identity.
  //
  // It is intentionally NOT `server.name`: a `Server` row is just a logical
  // registration a user created, and nothing stops two different rows from
  // pointing at the same SSH host + account — in which case they resolve to
  // the exact same `~/.azito/repos/<repoHash>.git` mirror on that machine
  // (Issue #87 review, fifth pass, Important finding 1). Keying the lock by
  // `server.name` would let those two rows distribute concurrently, each
  // building off the mirror ref it read before the other's forced-refspec
  // fetch landed — and because the mirror fetch is forced, a bundle that
  // started from a now-stale prerequisite can overwrite the mirror's ref
  // with older content than what's already there. `sshHost` + `homeDir` +
  // `repoHash` is what actually determines the mirror's on-disk path
  // (`RemoteBundleOps.mirrorDir(homeDir, repoHash)`, reached over `sshHost`),
  // so two rows that resolve to the same path always share this lock key,
  // and two rows that don't never contend for it. `homeDir` must therefore
  // be resolved BEFORE this lock is acquired (`distribute()` does this,
  // ahead of calling `distributeUnlocked()`), not inside the locked section.
  //
  // `resolvedHostIdentity` (not the raw `sshHost` string) is what actually
  // goes into the key, via `resolveHostIdentityForLockKey()` below — see its
  // doc comment (Issue #87 review, 6th pass, Important finding 3) for why
  // the raw string alone under-serializes: SFTP resolves `sshHost` through
  // SSH config/aliasing before connecting, so `host` and `host:22`, or two
  // differently-spelled aliases for the same account, can share this exact
  // mirror path while taking different raw-string lock keys.
  //
  // The hub runs as a single process, so an in-memory promise chain (no
  // DB-level lock needed) is sufficient — same pattern as
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
  private readonly hubCacheMutex = new KeyedMutex();

  // Third mutex, keyed by `${hostIdentity}:${normalizedWorkingDir}` —
  // serializes `ensureWorkingDir()` (Issue #87 review, 8th pass, Important
  // finding 2). `this.mutex` above protects the shared MIRROR
  // (`<homeDir>/.azito/repos/<repoHash>.git`) by a key derived from
  // `repoHash`, but `ensureWorkingDir()` also clones/fetches/detaches/
  // updates refs in `workingDir` — a DIFFERENT path that is not
  // 1:1 with the mirror. Two `project_servers` rows (or two projects) can
  // legitimately point different `repositoryId`s at the SAME `workingDir`
  // (operator misconfiguration, or two registrations that happen to share
  // a filesystem path), in which case they'd take DIFFERENT `this.mutex`
  // keys (different `repoHash`) but need to run their clone/fetch/detach/
  // ref-update sequence against that one checkout serially, or one call's
  // half-finished clone/detach can be interleaved with the other's,
  // corrupting the checkout. Keyed by the same `hostIdentity` as `this.mutex`
  // (see `resolveHostIdentityForLockKey()`) plus the normalized `workingDir`
  // path (see `normalizeWorkingDirForLockKey()`) so aliased hosts and
  // trailing-slash path spelling still collapse to one key.
  private readonly workingDirMutex = new KeyedMutex();

  // ── Lock ordering (all three mutexes in this class) ──
  // Always acquired OUTER -> INNER in this fixed order, never the reverse,
  // and never held concurrently with an attempt to acquire an earlier one
  // in the list:
  //   1. `this.mutex`        — keyed `${hostIdentity}:${homeDir}:${repoHash}`,
  //                            taken by `distribute()`, held for the whole
  //                            `distributeUnlocked()` call.
  //   2. `this.workingDirMutex` — keyed `${hostIdentity}:${normalizedWorkingDir}`,
  //                            taken only around `ensureWorkingDir()` calls
  //                            inside `distributeUnlocked()` (i.e. always
  //                            while (1) is held, never while (3) is held —
  //                            both call sites run after `prepareBundle()`'s
  //                            `hubCacheMutex.withLock()` has already
  //                            resolved).
  //   3. `this.hubCacheMutex` — keyed `repoHash` alone, taken inside
  //                            `distributeUnlocked()` (`prepareBundle()`)
  //                            and inside `deliverToMirror()`'s fallback
  //                            branch, both while (1) is held.
  // Nothing in this class ever holds (2) or (3) while trying to acquire (1),
  // and nothing ever holds (3) while trying to acquire (2) (they are never
  // nested against each other — see the call sites above), so no pair here
  // can deadlock against another.
  //
  // Out of scope: this only serializes concurrent distributions within THIS
  // hub process. It does not take any lock on the remote filesystem itself,
  // so a second hub process (or an operator/script touching the same
  // `workingDir` or mirror directly, out of band) is not protected against.
  // Symlink aliases are the same kind of gap (Issue #87 review, 15th pass):
  // `normalizeWorkingDirForLockKey()` below is purely lexical, so two
  // DIFFERENT `workingDir` strings that a symlink (or bind mount) makes
  // resolve to the SAME actual checkout — e.g. `/srv/current/repo` and
  // `/opt/repos/repo` — take different lock keys and can race each other.
  // Left unfixed: closing it needs an extra remote round trip per
  // distribution to resolve the physical path (readlink/realpath on the
  // remote host) before the lock key can be built, and this class already
  // resolves `homeDir` remotely once per call — a second remote resolution
  // just for lock-key purposes is not worth it for the deployment shapes
  // this project actually targets (a project server's working directory is
  // configured once and not normally symlink-aliased across distributions).

  constructor(
    private hubRepoCache: HubRepoCache,
    private remoteBundleOps: RemoteBundleOps,
    private sftpService: SftpService,
    private distributionStateRepo: IDistributionStateRepository,
    // Issue #87 review, 6th pass, Important finding 3: optional — resolves
    // `sshHost` to its actual connection identity (host/port/username) for
    // the lock key below, the same identity SFTP itself connects through
    // (`SshClient.resolveHost`, via `~/.ssh/config` aliasing). Without this,
    // the lock key was the RAW `sshHost` string, so `host` and `host:22`, or
    // two differently-named `~/.ssh/config` aliases that resolve to the same
    // host/port/user, took DIFFERENT lock keys while writing the SAME
    // `<homeDir>/.azito/repos/<repoHash>.git` mirror — two concurrent forced
    // fetches into that mirror could interleave and let an older delivery
    // overwrite a newer one. Typed structurally (not `SshClient` itself) so
    // this module doesn't need to construct or mock the real SSH stack;
    // `wiring.ts` passes the hub's actual `SshClient`. `null` (e.g. in
    // tests that don't care about alias collapsing) falls back to the raw
    // string — see `resolveHostIdentityForLockKey()`.
    private sshHostResolver: { resolveHost(hostStr: string): { host: string; port: number; username: string } } | null = null,
  ) {}

  // Falls back to the raw `sshHost` string (prefixed so it can never collide
  // with a resolved `host:port:username` triple) when no resolver is wired,
  // or when resolution itself throws (e.g. an unparseable host spec) — the
  // lock still behaves correctly for that single unresolved alias, it just
  // won't collapse with an equivalent alias spelled differently. Keeping the
  // same `<key>:<homeDir>:<repoHash>` shape either way is what the caller
  // relies on (Issue #87 review, 6th pass, Important finding 3).
  private resolveHostIdentityForLockKey(sshHost: string): string {
    if (!this.sshHostResolver) return `raw:${sshHost}`;
    try {
      const resolved = this.sshHostResolver.resolveHost(sshHost);
      return `${resolved.host}:${resolved.port}:${resolved.username}`;
    } catch {
      return `raw:${sshHost}`;
    }
  }

  // Issue #87 review, 8th pass, Important finding 2: normalizes `workingDir`
  // for `workingDirMutex`'s key so two spellings of the same remote path
  // (trailing slash, repeated slashes) collapse to one lock. Distribution
  // only ever targets `agent`-type servers (`ServerConfig.type` is `'local'
  // | 'agent'`; the retired `ssh` server type is disabled by migration
  // `058_disable_ssh_servers` — see docs/{en,ja}/code-distribution.md), and
  // an agent server is always a remote POSIX host, so POSIX normalization
  // is correct here — this class never operates on `local`.
  private normalizeWorkingDirForLockKey(workingDir: string): string {
    const normalized = path.posix.normalize(workingDir);
    return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
  }

  async distribute(params: FetchDistributionParams): Promise<FetchDistributionResult> {
    const { server, transport, repoIdentity } = params;
    const sshHost = server.sshHost;
    if (!sshHost) {
      return { status: 'failed', error: 'Server has no sshHost configured for SFTP transfer' };
    }

    // Resolved BEFORE the outer lock is acquired — see `this.mutex`'s doc
    // comment above for why the lock key must be built from `sshHost` +
    // `homeDir` + `repoHash` rather than `server.name`, and
    // `resolveHostIdentityForLockKey`'s doc comment for why `sshHost` itself
    // is normalized first.
    let homeDir: string;
    try {
      homeDir = await this.remoteBundleOps.resolveHomeDir(transport);
    } catch (err) {
      return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
    }

    const repoHash = computeRepoHash(repoIdentity);
    const hostIdentity = this.resolveHostIdentityForLockKey(sshHost);
    return this.mutex.withLock(`${hostIdentity}:${homeDir}:${repoHash}`, () =>
      this.distributeUnlocked(params, sshHost, homeDir, repoHash, hostIdentity));
  }

  private async distributeUnlocked(
    params: FetchDistributionParams,
    sshHost: string,
    homeDir: string,
    repoHash: string,
    hostIdentity: string,
  ): Promise<FetchDistributionResult> {
    const { server, transport, repoIdentity, token, branch, workingDir, repositoryId, onBeforeWorkingDirChange } = params;

    try {
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

      // Issue #87 review, 8th pass, Important finding 2: `ensureWorkingDir()`
      // clones/fetches/detaches/updates refs in `workingDir` — a path not
      // 1:1 with the mirror lock key above (see `workingDirMutex`'s doc
      // comment for why a second lock, keyed by the actual path, is needed).
      // Both call sites below acquire it, always while `this.mutex` (the
      // outer mirror lock) is already held and never while `hubCacheMutex`
      // is held — see the class-level "Lock ordering" comment.
      const workingDirLockKey = `${hostIdentity}:${this.normalizeWorkingDirForLockKey(workingDir)}`;

      if (prep.kind === 'current') {
        // workingDir may still be missing or stale (e.g. it was deleted
        // separately from the mirror), so it's ensured even when the
        // transfer itself was skipped. Everything above this point
        // (`ensureMirror`/`getMirrorBranchSha`/`prepareBundle`) has already
        // succeeded, so this is the point of no return before `workingDir`
        // itself is touched — see `onBeforeWorkingDirChange`'s doc comment
        // on `FetchDistributionParams`.
        onBeforeWorkingDirChange?.();
        const localBranchSynced = await this.workingDirMutex.withLock(workingDirLockKey, () =>
          this.ensureWorkingDir(transport, mirrorDir, workingDir, branch, repoHash, repoIdentity));
        return { status: 'already_current', sha: prep.headSha, localBranchSynced };
      }

      // Upload/verify/apply runs OUTSIDE `hubCacheMutex` — see the lock's
      // doc comment above for why.
      const delivered = await this.deliverToMirror(transport, sshHost, repoHash, repoIdentity, branch, mirrorDir, prep);

      // Same point-of-no-return rationale as the `already_current` branch
      // above — `deliverToMirror()` has now succeeded (or thrown, caught
      // below without ever reaching here), so `workingDir` is about to
      // change.
      onBeforeWorkingDirChange?.();
      const localBranchSynced = await this.workingDirMutex.withLock(workingDirLockKey, () =>
        this.ensureWorkingDir(transport, mirrorDir, workingDir, branch, repoHash, repoIdentity));

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
   *
   * Falls back to full ONLY when the failure indicates something about the
   * INCREMENTAL BUNDLE'S CONTENT was rejected — the remote couldn't verify
   * it (its prerequisite commit is missing/invalid on that mirror) or
   * couldn't apply it — because a full bundle (no prerequisite) can succeed
   * where those fail. A `BundleTransferError` (SFTP connect/auth/timeout)
   * is propagated immediately instead: the transfer layer failed, not the
   * bundle's content, so a full bundle would fail identically, and retrying
   * only spends a second multi-minute SFTP timeout waiting on an
   * unreachable/rejecting server (Issue #87 review, fifth pass, Important
   * finding 2). See `BundleTransferError`'s own doc comment for the full
   * rationale.
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
      // Transfer-layer failure (SFTP connect/auth/timeout): switching bundle
      // type would not help and would only cost a second SFTP timeout — see
      // this method's doc comment.
      if (err instanceof BundleTransferError) throw err;
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
      // Wrapped in `BundleTransferError` so `deliverToMirror()` can tell a
      // transfer-layer failure (connect/auth/timeout — retrying with a
      // different bundle type would not help) apart from a failure caused
      // by the bundle's own content (verify/apply below, which a full
      // bundle CAN route around) without string-matching the error message.
      // `cause` preserves the original failure for logging/debugging.
      try {
        await this.sftpService.upload(sshHost, bundleResult.bundlePath, remoteTmpPath);
      } catch (err) {
        throw new BundleTransferError(
          `SFTP upload to ${sshHost} failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }

      // `verify()`/`fetchBundleIntoMirror()` throw `RemoteGitCommandError`
      // now (Issue #87 third-party review, seventh pass, Important finding
      // 1: the exit-status sentinel). `transportFailure: true` means the
      // remote command never completed at all (connection drop, command
      // timeout) — that's a transfer/execution-layer anomaly, not git
      // rejecting the bundle's content, so it's re-classified as
      // `BundleTransferError` here for the exact same reason the SFTP
      // upload failure above already is: `deliverToMirror()`'s
      // incremental->full fallback must not retry a different bundle for a
      // failure that has nothing to do with which bundle was sent (Issue
      // #87 third-party review, seventh pass, Important finding 4). A
      // `transportFailure: false` error means git actually ran and
      // rejected the content (e.g. a missing prerequisite commit) — that
      // one falls through unwrapped so the existing fallback-to-full logic
      // still applies to it, unchanged from before this fix.
      try {
        const verified = await this.remoteBundleOps.verify(transport, mirrorDir, remoteTmpPath);
        if (!verified) {
          throw new Error('Bundle verification failed on remote');
        }

        // Forced refspec + --atomic: tolerates the mirror's branch having
        // diverged from this bundle's prerequisite (e.g. a concurrent
        // force-push upstream) instead of failing non-fast-forward forever.
        await this.remoteBundleOps.fetchBundleIntoMirror(transport, mirrorDir, remoteTmpPath, branch);
      } catch (err) {
        if (err instanceof RemoteGitCommandError && err.transportFailure) {
          throw new BundleTransferError(
            `Remote git command on ${sshHost} did not complete (transport/execution failure): ${err.message}`,
            { cause: err },
          );
        }
        throw err;
      }
    } finally {
      // Best-effort: an exception raised while cleaning up the remote temp
      // bundle must never replace the original try-block error (Issue #87
      // third-party review, seventh pass, Important finding 4) — the
      // caller's fallback/failure classification above is based on THAT
      // error, not on whatever `rm -f` happened to do afterwards.
      try {
        await this.remoteBundleOps.cleanup(transport, remoteTmpPath);
      } catch {
        // best-effort cleanup only
      }
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
   *
   * Before touching an EXISTING `workingDir` (`repoExists` true), verifies
   * it is actually a checkout of `repoHash`'s repository, not a different
   * one that happens to share this filesystem path (Issue #87 third-party
   * review, 10th round, Important finding 2: two project/server
   * registrations pointing at the same `workingDir` used to let the second
   * one's distribution silently fetch an unrelated mirror into the first
   * one's checkout and force-update its `origin/<branch>`). The
   * `workingDirMutex` this method is always called under only serializes
   * concurrent access to the SAME path — it does nothing to stop two
   * DIFFERENT repositories from being configured to use that same path in
   * the first place, which is what this stamp check catches.
   *
   * A `workingDir` created before this stamping existed carries no stamp at
   * all (`getStampedRepoHash` returns `null`). Issue #87 third-party review,
   * 11th round, Important finding 2: it used to be treated as unconditionally
   * trustworthy for that case — fetched from the mirror, ref force-updated,
   * origin replaced — with the stamp back-filled only AFTER all of that
   * mutation. A misconfigured project server (pointed at some unrelated
   * existing checkout) would silently rewrite that checkout before the new
   * mismatch detection ever got a chance to run once. `verifyUnstampedIdentity`
   * below now runs BEFORE any mutation and resolves that case into exactly
   * one of three outcomes:
   *  1. `origin` is EXACTLY the dummy sentinel this class itself sets
   *     (`DUMMY_ORIGIN_URL`) — the only signal that reliably means "this
   *     workingDir was itself created by a prior AZITO distribution, before
   *     repoHash stamping existed" (this class always replaces `origin`
   *     with the dummy URL, so that's exactly what an un-migrated
   *     AZITO-managed workingDir looks like). Stamped, then treated the
   *     same as an already-stamped match.
   *  2. `origin` is a real upstream URL whose identity matches `repoHash`
   *     (compared via `resolveCanonicalRepositoryIdentity`'s parsed
   *     host/owner/repo, not a raw string compare — Issue #87 13th-round
   *     review, Important finding 4: a plain string compare treats
   *     `https://github.com/acme/repo` and `.../repo.git` as different
   *     repositories) — a legitimate pre-stamping checkout. Stamped, then
   *     treated the same as an already-stamped match.
   *  3. Anything else — `origin` unset, unparseable, or a real upstream URL
   *     whose identity does NOT match — FAILS CLOSED, `workingDir` is left
   *     untouched. Issue #87 13th-round review, Important finding 3: this
   *     used to also accept outcome 3 with a warning, on the theory that a
   *     workingDir with no identifiable origin was "probably" AZITO's own.
   *     That is not a safe assumption — an ordinary, unrelated local
   *     repository with no origin configured (or one this method just can't
   *     parse) is common, and adopting it means fetching foreign objects
   *     into it, detaching its HEAD, force-moving its local branches, and
   *     overwriting its origin: destroying a repository AZITO never created
   *     and has no business touching. Narrowing outcome 1 to an EXACT
   *     `DUMMY_ORIGIN_URL` match and failing everything else closed trades
   *     "distribution to a genuinely un-migrated AZITO checkout might need a
   *     one-time manual fix" for "distribution can no longer silently
   *     destroy an unrelated repository" — the latter is the only
   *     acceptable default here.
   */
  private async ensureWorkingDir(transport: IServerTransport, mirrorDir: string, workingDir: string, branch: string, repoHash: string, repoIdentity: CanonicalRepositoryIdentity): Promise<boolean> {
    const exists = await this.remoteBundleOps.repoExists(transport, workingDir);
    if (exists) {
      const stampedRepoHash = await this.remoteBundleOps.getStampedRepoHash(transport, workingDir);
      if (stampedRepoHash !== null && stampedRepoHash !== repoHash) {
        throw new Error(
          `workingDir "${workingDir}" is stamped for a different repository (repoHash ${stampedRepoHash}) than the one being distributed (repoHash ${repoHash}). ` +
          'Two project/server registrations appear to target the same working directory — point them at separate working directories, or review this server\'s project configuration.',
        );
      }
      if (stampedRepoHash === null) {
        // Confirms identity (or accepts back-compat ambiguity) and stamps
        // BEFORE any mutation below — see this method's doc comment.
        await this.verifyUnstampedIdentity(transport, workingDir, repoHash, repoIdentity);
      }
      await this.remoteBundleOps.fetchWorkingDirFromMirror(transport, mirrorDir, workingDir, branch);
    } else {
      await this.remoteBundleOps.cloneWorkingDirFromMirror(transport, mirrorDir, workingDir, branch);
      // Dummy origin is set BEFORE stamping (Issue #87 14th-round review,
      // Important finding 2): `git clone` leaves `origin` pointed at the
      // local `mirrorDir` path. If `stampRepoHash` below fails partway
      // through post-clone init, a naive clone-then-stamp order left
      // `workingDir` permanently unrecoverable — unstamped, with `origin`
      // reading as neither `DUMMY_ORIGIN_URL` nor a real upstream URL, so
      // every future retry's `verifyUnstampedIdentity` (outcome 3 in this
      // method's doc comment) fails closed forever and requires manual
      // cleanup. Setting the dummy origin FIRST means that even if stamping
      // then fails, the next retry's `verifyUnstampedIdentity` sees outcome
      // 1 (`origin` already the dummy sentinel), stamps, and proceeds
      // normally — no manual intervention needed. `setDummyOrigin` is
      // idempotent, so calling it again at the end of this method (below)
      // for the already-set case is harmless.
      await this.remoteBundleOps.setDummyOrigin(transport, workingDir);
      // Brand-new clone: nothing to verify, nothing pre-existing to protect.
      await this.remoteBundleOps.stampRepoHash(transport, workingDir, repoHash);
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

  /**
   * Establishes the identity of an UNSTAMPED, pre-existing `workingDir`
   * before `ensureWorkingDir` mutates it in any way (fetch/ref-force-update/
   * origin replace) — see `ensureWorkingDir`'s doc comment for the three
   * outcomes this resolves into. Stamps on the two outcomes that proceed;
   * throws (leaving `workingDir` untouched) on the one that doesn't.
   */
  private async verifyUnstampedIdentity(transport: IServerTransport, workingDir: string, repoHash: string, repoIdentity: CanonicalRepositoryIdentity): Promise<void> {
    const originUrl = await this.remoteBundleOps.getOriginUrl(transport, workingDir);

    // Issue #87 13th-round review, Important finding 3: adopting an
    // unstamped workingDir is ONLY safe when its origin is AZITO's own
    // dummy sentinel — i.e. this directory was itself created by a PRIOR
    // distribution (before repoHash stamping existed), never touched since.
    // A real, unrelated local repository with no origin configured (or with
    // an origin this method can't confidently parse) is an entirely
    // ordinary thing for a developer to have lying around; the previous
    // "no identifiable origin -> assume it's ours and adopt it" rule would
    // fetch foreign objects into it, detach its HEAD, force-move its local
    // branches, and overwrite its origin the moment fetch distribution ran
    // against that server — destroying a repository AZITO never created and
    // has no business touching. Narrowing this to an EXACT DUMMY_ORIGIN_URL
    // match closes that: everything else now fails closed instead of being
    // silently adopted.
    if (originUrl === DUMMY_ORIGIN_URL) {
      await this.remoteBundleOps.stampRepoHash(transport, workingDir, repoHash);
      return;
    }

    // `originUrl` (read from the remote's own git config, not from this
    // codebase's own repository configuration) and `repoIdentity.httpsUrl`
    // (the URL being distributed, which can itself carry query-string
    // credentials some hosting providers accept in place of userinfo) are
    // NEVER embedded raw in a log or error message here — both commonly
    // carry embedded credentials (`https://user:token@host/repo.git`, a
    // standard way to configure git push/fetch auth outside this
    // codebase's own `GIT_ASKPASS` flow), and both this warning and the
    // errors below reach a task's execution log, which is visible to
    // whoever can see the task (Issue #87 third-party review, 12th round,
    // Important finding 1; 15th round, Important finding 1 extended this
    // to `repoIdentity.httpsUrl` and to query/fragment stripping).
    // `redactGitUrlCredentials` strips userinfo, query string, and
    // fragment before any of these messages are built.
    if (!originUrl) {
      throw new Error(
        `workingDir "${workingDir}" is not stamped for any repository and has no origin configured, so it cannot be identified as an AZITO distribution target (repoHash ${repoHash}). ` +
        'Point this server\'s project configuration at a different working directory, or manually verify/clear this one before distributing to it.',
      );
    }

    // Compare via resolveCanonicalRepositoryIdentity (reused, not
    // reimplemented — Issue #87 13th-round review, Important finding 4):
    // the plain normalized-URL string comparison this used to do treats
    // `https://github.com/acme/repo` and `https://github.com/acme/repo.git`
    // as different repositories, which blocks every distribution to a
    // working directory whose origin happens to carry (or lack) the `.git`
    // suffix. Comparing the parsed host/owner/repo instead makes those
    // equivalent while still rejecting a genuinely different repository.
    const originIdentity = resolveCanonicalRepositoryIdentity({
      url: originUrl,
      provider: repoIdentity.provider,
      owner: null,
      repoName: null,
    });
    if (!originIdentity.ok) {
      throw new Error(
        `workingDir "${workingDir}" is not stamped for any repository, and its origin ("${redactGitUrlCredentials(originUrl)}") could not be normalized to a canonical identity, so it cannot be identified as an AZITO distribution target (repoHash ${repoHash}). ` +
        'Point this server\'s project configuration at a different working directory, or manually verify/clear this one before distributing to it.',
      );
    }

    // Origin identifies a real upstream repository — it MUST match the one
    // being distributed. Case-insensitive, same convention
    // `resolveCanonicalRepositoryIdentity` uses for owner/repo comparison.
    const matches =
      originIdentity.identity.host.toLowerCase() === repoIdentity.host.toLowerCase() &&
      originIdentity.identity.owner.toLowerCase() === repoIdentity.owner.toLowerCase() &&
      originIdentity.identity.repo.toLowerCase() === repoIdentity.repo.toLowerCase();
    if (!matches) {
      throw new Error(
        `workingDir "${workingDir}" is not stamped for any repository, and its origin ("${redactGitUrlCredentials(originUrl)}") identifies a DIFFERENT repository than the one being distributed ("${redactGitUrlCredentials(repoIdentity.httpsUrl)}"). ` +
        'This working directory appears to belong to a different repository — point this server\'s project configuration at a separate working directory, or verify the configured repository.',
      );
    }

    // Origin matches: a legitimate pre-stamping checkout of this repository.
    await this.remoteBundleOps.stampRepoHash(transport, workingDir, repoHash);
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
