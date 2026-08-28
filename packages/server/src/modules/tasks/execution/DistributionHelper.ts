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
  };
}
