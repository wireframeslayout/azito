import type { ServerConfig } from '../../servers/Server';
import type { ProjectDetail, ProjectRepository } from '../../projects/Project';
import type { ProjectServer } from '../../projects/ProjectServer';
import type { IProjectRepository } from '../../projects/Project';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import { resolveCanonicalRepositoryIdentity } from '../../git/resolveCanonicalRepositoryIdentity';
import { normalizeBranchRef } from '../../git/assertSafeGitArgs';
import type { FetchDistributionService } from '../../git/hub-transfer/FetchDistributionService';

/**
 * Shared by ExecuteTaskUseCase and TaskRestoreService (Issue #87 13th-round
 * review, Important finding 1): both entry points create a task window and
 * then (re)create its worktree from `workingDir`, so both need the exact
 * same "does this server/project need code distributed onto it, and is the
 * distribution actually possible" logic — an isolated server or a
 * `distribute_code` project server must never have its worktree recreated
 * from stale/absent local content just because a task happened to go
 * through restore() instead of execute().
 *
 * Deliberately stops at "run the prerequisite checks and the distribution
 * itself, return the outcome" — it does NOT touch task status, does NOT log,
 * and does NOT roll back the caller's tmux window/token. Those differ enough
 * between execute() (rollbackWindowAfterPostCreationFailure, several distinct
 * rollback reason strings) and restore() (its own try/catch around the whole
 * window+worktree span) that folding them in here would either lose
 * information the two callers actually use differently, or force one of them
 * to adopt behavior it doesn't have today. See each call site for how it
 * turns a `{ ok: false }` outcome into its own rollback + task status update.
 */

export type DistributionFailureStage =
  | 'service_not_wired'
  | 'no_working_dir'
  | 'no_distribution_repository'
  | 'distribution_repository_not_found'
  | 'no_token'
  | 'identity_unresolvable'
  | 'distribute_failed'
  | 'stale_local_branch';

export type DistributionOutcome =
  | { required: false }
  | {
      required: true;
      ok: true;
      distStatus: 'distributed' | 'already_current';
      sha?: string;
      bundleType?: 'full' | 'incremental';
      localBranchSynced?: boolean;
      // The `project_repositories` id distribution actually pulled code
      // from (Issue #87 review follow-up, Important finding 1) — the
      // caller persists this onto `task.distributionRepositoryId` so a
      // LATER resume (which must never re-resolve the distribution target
      // from the project/project-server's THEN-current configuration —
      // the task's working directory already holds code from THIS
      // repository, not whatever the config points at by the time resume
      // runs) can use the value that was actually true at distribution
      // time.
      repositoryId: number;
    }
  | { required: true; ok: false; stage: DistributionFailureStage; message: string };

/**
 * Whether `server`/`projectServer` requires fetch distribution before a
 * worktree can be created on it — a property of server/project
 * configuration alone, never of whether a working directory happens to be
 * set (Issue #87 review, forge/87-mirror follow-up, Important finding 2).
 */
export function isDistributionRequired(
  server: Pick<ServerConfig, 'type' | 'isolationIntent'>,
  projectServer: Pick<ProjectServer, 'distributeCode'> | null,
): boolean {
  return server.type !== 'local' && !!(server.isolationIntent || projectServer?.distributeCode);
}

/**
 * Resolves which `project.repositories` entry an actual run should treat as
 * THE repository — used for every downstream decision that follows from
 * "which repository did this run's code come from/go to" (push
 * verification, PR creation, hub push notarization, the approval manifest's
 * repository identity — Issue #87 13th-round review, Important finding).
 *
 * Deliberately mirrors `isDistributionRequired`'s condition rather than
 * re-deriving it: whenever fetch distribution is (or would be) active for
 * this server/project-server pairing, the ONLY repository this function may
 * return is the one named by `distributionRepositoryId` — that is the
 * repository whose code actually landed on the server, so every downstream
 * consumer must agree with `performDistribution`'s own choice
 * (DistributionHelper's module doc comment).
 *
 * Issue #87 review (14th round), Important finding: this function used to
 * fall through to `project.repositories[0]` whenever
 * `distributionRepositoryId` was unset OR named a repository that no longer
 * exists on the project — i.e. exactly the two situations where the
 * distributed repository is unknown or gone. That reintroduced the
 * distribution/push mismatch this function exists to prevent: delete
 * repository B after code was distributed from it, and every downstream
 * consumer (push verification, PR creation, hub notarization, the approval
 * manifest) would silently retarget repository A. When distribution is
 * required, this function now returns the resolved entry or `null` —
 * NEVER `project.repositories[0]` — so a caller that receives `null` here
 * knows the distributed repository could not be identified and must decide
 * for itself whether that is safe to proceed without (e.g. read-only PR
 * lookup) or must hard-fail (e.g. an actual push/notarization write).
 *
 * Falls back to `project.repositories[0]` ONLY when distribution is not
 * required at all (local server, or an agent/ssh server with neither
 * `isolationIntent` nor `distributeCode`) — so every project that has never
 * touched hub-代行 distribution keeps its pre-existing behavior unchanged.
 */
export function resolveExecutionRepositoryEntry(
  server: Pick<ServerConfig, 'type' | 'isolationIntent'> | null,
  projectServer: Pick<ProjectServer, 'distributeCode' | 'distributionRepositoryId'> | null,
  project: Pick<ProjectDetail, 'repositories'> | null,
): ProjectRepository | null {
  if (server && isDistributionRequired(server, projectServer)) {
    const distributionRepositoryId = projectServer?.distributionRepositoryId ?? null;
    if (distributionRepositoryId == null) return null;
    return project?.repositories?.find((r) => r.id === distributionRepositoryId) ?? null;
  }
  return project?.repositories?.[0] ?? null;
}

/**
 * Whether push verification (and PR creation/verification/notarization) must
 * fail closed because distribution is required for this server/project-server
 * pairing but the distributed repository could not be resolved (unset
 * `distributionRepositoryId`, or it names a repository that no longer exists
 * — see `resolveExecutionRepositoryEntry`'s doc comment for why that resolver
 * returns `null` rather than falling back to `project.repositories[0]` in
 * this exact situation).
 *
 * Extracted (Issue #87 review, forge/87-mirror follow-up, Important finding
 * 2) so `ExecuteTaskUseCase.isPushCompleted()` and `PhaseLoopRunner`'s
 * pushing-phase completion probe apply the SAME rule instead of each
 * hand-rolling their own copy — that duplication is exactly how the probe
 * side drifted out of sync with `isPushCompleted()`'s fix in the first
 * place. `PushVerifier.verifyPushCompleted()` treats a missing `repo` as "no
 * repository info to check against, skip PR verification, trust the SHA
 * match alone" — a fallback that only makes sense for a project that never
 * registered a repository at all. Reusing that fallback here (distribution
 * required but the target repository is unresolved) would silently accept
 * "push completed" without ever having checked the actual target repository
 * or its PR — so both callers must check this FIRST and refuse to call PR
 * creation/verification at all when it's true, treating the probe as
 * not-yet-completed instead.
 *
 * Distribution-not-required callers are unaffected: `isDistributionRequired`
 * is false there, so this always returns `false` regardless of `repo`,
 * preserving the pre-existing SHA-only verification behavior for projects
 * that have never touched distribution.
 */
export function isDistributionRequiredButRepositoryUnresolved(
  server: Pick<ServerConfig, 'type' | 'isolationIntent'>,
  projectServer: Pick<ProjectServer, 'distributeCode'> | null,
  repo: unknown | null | undefined,
): boolean {
  return isDistributionRequired(server, projectServer) && !repo;
}

/**
 * Result of resolving the repository a resumed/continued run (follow-up,
 * resumeStateMachine, isPushCompleted) must treat as THE repository, given a
 * task's recorded `distributionRepositoryId` (Issue #87 review follow-up,
 * Important findings 2 & 3).
 *
 * `ok: false` means the task has a recorded value that no longer resolves —
 * the repository row was deleted since distribution ran. The caller MUST
 * fail closed (never fall back to `resolveExecutionRepositoryEntry`'s
 * current-config resolution) — see `resolveRecordedDistributionRepositoryEntry`'s
 * doc comment for why.
 */
export type RecordedDistributionRepositoryResolution =
  | { ok: true; entry: ProjectRepository | null }
  | { ok: false; recordedRepositoryId: number };

/**
 * Single source of truth for "which repository must this task's resumed/
 * continued execution treat as THE repository", shared by
 * `ExecuteTaskUseCase.resumeStateMachine()`, `followUp()`'s state-machine
 * continuation, and `isPushCompleted()` (Issue #87 review follow-up,
 * Important findings 2 & 3 — those three call sites used to each hand-roll
 * this same rule, and two of them had drifted to re-resolving from the
 * project/project-server's CURRENT configuration instead).
 *
 * A task's working directory holds code from whichever repository fetch
 * distribution actually pulled it from at execute()/restore() time
 * (`task.distributionRepositoryId`, migration 067) — that fact never changes
 * for the life of the task's working directory, even if an operator later
 * repoints the project server's `distributionRepositoryId` at a different
 * repository, or deletes the recorded one outright. So:
 *
 * - A non-null recorded value is authoritative and MUST be used as-is. If it
 *   no longer resolves (the repository row was deleted), this returns
 *   `{ ok: false }` and the caller must refuse to proceed with a different
 *   repository (fail closed) — falling back to the live config here is
 *   exactly the "notarize/push repository A's code against repository B"
 *   bug this column exists to prevent.
 * - A null recorded value means either the task predates this column, or its
 *   execute()/restore() run never went through distribution at all — in
 *   that case this falls back to `resolveExecutionRepositoryEntry`'s live
 *   resolution exactly as every call site did before this column existed
 *   (itself already fail-closed when distribution is currently required but
 *   unresolved, and a plain `repositories[0]` lookup otherwise).
 */
export function resolveRecordedDistributionRepositoryEntry(
  recordedRepositoryId: number | null | undefined,
  server: Pick<ServerConfig, 'type' | 'isolationIntent'> | null,
  projectServer: Pick<ProjectServer, 'distributeCode' | 'distributionRepositoryId'> | null,
  project: Pick<ProjectDetail, 'repositories'> | null,
): RecordedDistributionRepositoryResolution {
  if (recordedRepositoryId != null) {
    const resolved = project?.repositories?.find((r) => r.id === recordedRepositoryId) ?? null;
    if (!resolved) return { ok: false, recordedRepositoryId };
    return { ok: true, entry: resolved };
  }
  return { ok: true, entry: resolveExecutionRepositoryEntry(server, projectServer, project) };
}

export interface PerformDistributionParams {
  server: ServerConfig;
  projectServer: Pick<ProjectServer, 'distributeCode' | 'distributionRepositoryId'> | null;
  project: Pick<ProjectDetail, 'repositories'> | null;
  workingDir: string | null;
  baseBranch: string;
  taskBranch: string | null;
  transportFactory: TransportFactory;
  projectRepo: IProjectRepository;
  fetchDistributionService: FetchDistributionService | null;
}

/**
 * Runs the full prerequisite validation (repository configured, exactly one
 * repository, token present, URL resolves to a canonical identity) and, if
 * all pass, the distribution itself — the same sequence
 * ExecuteTaskUseCase.execute() ran inline before this extraction. Returns a
 * discriminated result instead of throwing so each caller can apply its own
 * logging/rollback/task-status convention around a failure.
 */
export async function performDistribution(params: PerformDistributionParams): Promise<DistributionOutcome> {
  const { server, projectServer, project, workingDir, baseBranch, taskBranch, transportFactory, projectRepo, fetchDistributionService } = params;

  if (!isDistributionRequired(server, projectServer)) {
    return { required: false };
  }

  if (!fetchDistributionService) {
    return {
      required: true,
      ok: false,
      stage: 'service_not_wired',
      message: 'Fetch distribution is required (server isolation intent or project distribute_code) but FetchDistributionService is not wired',
    };
  }

  if (!workingDir) {
    return {
      required: true,
      ok: false,
      stage: 'no_working_dir',
      message: 'Fetch distribution is required (server isolation intent or project distribute_code) but no working directory is configured for this task/server',
    };
  }

  // Issue #87 explicit-target follow-up: the target repository is resolved
  // from `projectServer.distributionRepositoryId`, never inferred from
  // `project.repositories[0]`/"exactly one repository configured" — see
  // `ProjectServer.distributionRepositoryId`'s doc comment and this
  // function's own module doc comment. Required even when the project has
  // exactly one repository (deliberately not defaulted to it): an operator
  // approving distribution for a project server is approving "code from
  // THIS repository, on THIS server", and inferring a single-repository
  // project's implicit repository would let a later-added second repository
  // silently make a previously-unambiguous choice ambiguous again with no
  // signal at the project-server row itself — the explicit column is the
  // one place that choice is recorded and can be reviewed/changed
  // independently of how many repositories the project happens to have.
  const distributionRepositoryId = projectServer?.distributionRepositoryId ?? null;
  if (distributionRepositoryId === null) {
    return {
      required: true,
      ok: false,
      stage: 'no_distribution_repository',
      message: 'Fetch distribution is required but no distribution target repository is configured for this project server. Select one in Settings → Servers for this project/server pairing.',
    };
  }

  const repoEntry = project?.repositories?.find((r) => r.id === distributionRepositoryId);
  if (!repoEntry) {
    return {
      required: true,
      ok: false,
      stage: 'distribution_repository_not_found',
      message: 'Fetch distribution is required but the configured distribution target repository no longer exists on this project',
    };
  }

  const repo = projectRepo.findRepositoryById(repoEntry.id);
  if (!repo?.token) {
    return { required: true, ok: false, stage: 'no_token', message: 'Fetch distribution is required but the repository has no token configured' };
  }

  const identity = resolveCanonicalRepositoryIdentity(repo);
  if (!identity.ok) {
    return {
      required: true,
      ok: false,
      stage: 'identity_unresolvable',
      message: `Fetch distribution is required but the repository URL could not be normalized to a canonical identity: ${identity.reason}`,
    };
  }

  const transport = transportFactory.getTransport(server);
  const distResult = await fetchDistributionService.distribute({
    server,
    transport,
    repoIdentity: identity.identity,
    token: repo.token,
    branch: baseBranch,
    workingDir,
    repositoryId: repoEntry.id,
  });

  if (distResult.status === 'failed') {
    // Prefixed (unlike every other failure `message` in this function,
    // which is already a complete sentence) to match ExecuteTaskUseCase's
    // pre-extraction wording exactly — this is the one message vitest's
    // existing test suite asserts on verbatim.
    return { required: true, ok: false, stage: 'distribute_failed', message: `Fetch distribution failed: ${distResult.error ?? 'unknown error'}` };
  }

  // See ExecuteTaskUseCase's original comment on this guard for the full
  // TOCTOU rationale: only matters when `taskBranch` names the SAME branch
  // fetch distribution just (tried to) advance — any other branch/no branch
  // resolves `origin/<baseBranch>` at worktree-creation time and never
  // touches this possibly-stale local ref.
  if (
    distResult.localBranchSynced === false &&
    taskBranch &&
    normalizeBranchRef(taskBranch) === normalizeBranchRef(baseBranch)
  ) {
    return {
      required: true,
      ok: false,
      stage: 'stale_local_branch',
      message: `Fetch distribution succeeded but the local branch "${taskBranch}" in ${workingDir} could not be updated to the distributed content — it is likely checked out in another worktree on the server. Remove or update that worktree, or specify a different branch name for this task, and retry.`,
    };
  }

  return {
    required: true,
    ok: true,
    distStatus: distResult.status,
    sha: distResult.sha,
    bundleType: distResult.bundleType,
    localBranchSynced: distResult.localBranchSynced,
    repositoryId: repoEntry.id,
  };
}
