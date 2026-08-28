import type { ServerConfig } from '../../servers/Server';
import type { ProjectDetail } from '../../projects/Project';
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
  | 'no_repository'
  | 'multiple_repositories'
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

export interface PerformDistributionParams {
  server: ServerConfig;
  projectServer: Pick<ProjectServer, 'distributeCode'> | null;
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

  const repoEntry = project?.repositories?.[0];
  if (!repoEntry) {
    return { required: true, ok: false, stage: 'no_repository', message: 'Fetch distribution is required but the project has no repository configured' };
  }

  // See ExecuteTaskUseCase's original comment on this same guard: `[0]` is
  // only unambiguous when the project has exactly one repository — with 2+,
  // there is no mapping from a project server's working directory to a
  // specific repository, so refuse to guess.
  if ((project?.repositories?.length ?? 0) > 1) {
    return {
      required: true,
      ok: false,
      stage: 'multiple_repositories',
      message: 'Fetch distribution is required but the project has multiple repositories configured — the distribution target cannot be determined unambiguously. Either reduce this project to a single repository, or disable distribution (server isolation intent / project distribute_code) for this task.',
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
