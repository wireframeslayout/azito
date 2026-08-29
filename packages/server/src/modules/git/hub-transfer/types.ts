import type { CanonicalRepositoryIdentity } from '../resolveCanonicalRepositoryIdentity';
import type { ServerConfig } from '../../servers/Server';
import type { IServerTransport } from '../../servers/transport/ServerTransport';
import type { ProjectRepositoryWithToken } from '../../projects/Project';

// ── Distribution state (Phase 1) ──
//
// Issue #87 Phase 2 (bare mirror レイアウト): `distribution_state` は
// correctness の根拠（増分の prerequisite / already-current 判定）から観測用
// キャッシュへ格下げされた。`FetchDistributionService` はもう `findByServerAndRepo`
// を読まない — prerequisite もスキップ判定も、サーバー側 mirror の実 refs
// （`RemoteBundleOps.getMirrorBranchSha`）を都度照会して決める。DB と実体がずれても
// （mirror が手動で消された、force-push で祖先関係が変わった等）配信は自己修復する。

export interface DistributionStateRecord {
  lastDistributedSha: string;
  bundleType: 'full' | 'incremental';
  distributedAt: string;
}

export interface IDistributionStateRepository {
  upsert(serverName: string, repositoryId: number, sha: string, bundleType: 'full' | 'incremental'): void;
  deleteByServer(serverName: string): void;
  // Issue #87 review (forge/87-mirror follow-up, Important finding 3): the
  // only existing on-disk evidence that a GIVEN server has actually received
  // a GIVEN repository's content via fetch distribution — used by
  // `shouldClearRecordedDistributionRepository` (DistributionHelper.ts) to
  // decide whether a not-required-this-run execute()/restore() may clear
  // `task.distributionRepositoryId`. `null` when no row exists for this
  // exact `(serverName, repositoryId)` pair (never distributed, or the
  // server/repository named by the recorded id has changed).
  find(serverName: string, repositoryId: number): DistributionStateRecord | null;
}

// ── Fetch distribution (Phase 1) ──

export interface FetchDistributionParams {
  server: ServerConfig;
  transport: IServerTransport;
  repoIdentity: CanonicalRepositoryIdentity;
  token: string;
  branch: string;
  workingDir: string;
  repositoryId: number;
  /**
   * Called exactly once per `distribute()` call, synchronously, immediately
   * before the ONE step that actually mutates the LOCAL `workingDir`
   * (`ensureWorkingDir()` — see `FetchDistributionService.distributeUnlocked()`'s
   * two call sites, only one of which ever runs per invocation) — never
   * before `ensureMirror()`/`getMirrorBranchSha()`/`prepareBundle()`/
   * `deliverToMirror()`, all of which can fail (or, for the remote mirror
   * steps, mutate the REMOTE mirror without ever touching `workingDir`)
   * before this point (Issue #87 review, forge/87-mirror follow-up,
   * Important finding 2, third round). `DistributionHelper.performDistribution()`
   * uses this to persist `task.distributionRepositoryId` if and only if this
   * run is actually about to change what's on `workingDir`'s disk — a prior
   * accurate record must survive a failure that never reached this point
   * (e.g. `resolveHomeDir()` failing on an unset/unreachable `sshHost`, or
   * the hub's own repo-cache/mirror-transfer steps failing).
   */
  onBeforeWorkingDirChange?: () => void;
}

export interface FetchDistributionResult {
  status: 'distributed' | 'already_current' | 'failed';
  sha?: string;
  bundleType?: 'full' | 'incremental';
  error?: string;
  // Whether `workingDir`'s LOCAL branch ref was successfully advanced to the
  // distributed tracking ref (see `RemoteBundleOps.syncLocalBranchToTracking`).
  // Set for both `distributed` and `already_current` — `already_current`
  // still calls `ensureWorkingDir()`, which still attempts the sync, so it
  // can still fail even when no bundle transfer happened this call. Absent
  // for `failed` (no working directory step ran at all). Callers use this,
  // together with whether `task.branch` names the distributed branch, to
  // decide whether the gap this leaves behind can actually be reached by
  // stale content (see ExecuteTaskUseCase's use of it, Issue #87 review,
  // forge/87-mirror follow-up, Important finding 1).
  localBranchSynced?: boolean;
}

// ── Push notarization (Phase 2) ──

export interface PushNotaryParams {
  taskId: number;
  unitId: number;
  server: ServerConfig;
  transport: IServerTransport;
  worktreePath: string;
  branch: string;
  baseBranch: string | null;
  repo: ProjectRepositoryWithToken;
}

export interface PushNotaryResult {
  status: 'notarized' | 'already_up_to_date' | 'failed';
  sha?: string;
  error?: string;
}

export interface CleanPushResult {
  pushedSha: string;
}

// ── Shared ──

export const DUMMY_ORIGIN_URL = 'https://azito-isolated-no-direct-access.invalid/repo.git';
