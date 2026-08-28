import type { Task } from '../Task';
import type { ProjectDetail } from '../../projects/Project';
import type { IProjectServerRepository, ProjectServer } from '../../projects/ProjectServer';

const DEFAULT_TMUX_SESSION = 'azito';

/**
 * Resolves the server a task should execute on: the task's own `serverName`
 * override; when absent, the project's single project_servers entry is used
 * ONLY if exactly one exists. Zero entries (nothing to run on) or two or
 * more entries (ambiguous — picking one silently would make the execution
 * target nondeterministic) both return null. Callers decide whether null is
 * a fail-fast condition (execution) or a best-effort miss (read-only prompt
 * rendering).
 */
export function resolveTaskServerName(
  task: Pick<Task, 'projectId' | 'serverName'>,
  projectServerRepo: IProjectServerRepository,
): string | null {
  if (task.serverName) return task.serverName;
  const servers = projectServerRepo.findByProject(task.projectId);
  return servers.length === 1 ? servers[0].serverName : null;
}

/**
 * Resolves the tmux session to use for a task on the given (already
 * resolved) server. Falls back to the DB-level default ('azito') only when
 * no project_servers row links this project to that server yet.
 */
export function resolveTmuxSession(
  projectId: number,
  serverName: string,
  projectServerRepo: IProjectServerRepository,
): string {
  const ps = projectServerRepo.find(projectId, serverName);
  return ps?.tmuxSession || DEFAULT_TMUX_SESSION;
}

/**
 * Resolves the Unit id that governs both behavior and "what runs" a task:
 * the task's own override, falling back to the project's default. Returns
 * null when neither is set — callers must treat this as fail-fast (no
 * implicit default Unit).
 */
export function resolveUnitId(
  task: Pick<Task, 'unitId'>,
  project: Pick<ProjectDetail, 'defaultUnitId'> | null,
): number | null {
  return task.unitId ?? project?.defaultUnitId ?? null;
}

/**
 * Resolves the base branch a worktree is created from: the task's own
 * override, falling back to the project_servers row's branch, falling back
 * to the project's default branch, falling back to 'main'. Single source for
 * this precedence — ExecuteTaskUseCase.execute() and TaskRestoreService.
 * restore() both create a worktree from this same value, and
 * ExecutionManifest.ts hashes it via the same call, so the value a human
 * approves is guaranteed to be the value the run actually uses (Issue #328
 * fifth-round review).
 */
export function resolveBaseBranch(
  task: Pick<Task, 'baseBranch'>,
  projectServer: Pick<ProjectServer, 'branch'> | null,
  project: Pick<ProjectDetail, 'defaultBranch'> | null,
): string {
  return task.baseBranch || projectServer?.branch || project?.defaultBranch || 'main';
}

/**
 * Strips a leading `origin/` remote qualifier from a branch name, so a value
 * that is already remote-qualified (e.g. an existing task's `baseBranch:
 * 'origin/main'`, saved back when `origin/`-prefixed values were still
 * accepted at the API boundary — see `validateGitFields` in `routes.ts`)
 * does not get double-prefixed into the nonexistent ref `origin/origin/main`
 * (Issue #87 third-party review, 10th round, Important finding 1). Only a
 * single leading `origin/` is stripped: this is a normalization of the
 * remote qualifier, not a general path-segment strip, so a branch that
 * itself starts with `origin/origin/` (a legitimate branch name someone
 * chose) is left with one `origin/` removed, matching how `git` itself
 * treats `origin/` as the remote prefix only at the start of the ref.
 */
export function stripOriginPrefix(branch: string): string {
  return branch.startsWith('origin/') ? branch.slice('origin/'.length) : branch;
}

/**
 * Resolves the base branch to pass to worktree creation, given whether a
 * fetch distribution ran (and, if so, its outcome) for this server (Issue
 * #87 review, forge/87-mirror follow-up). `RemoteBundleOps.
 * fetchWorkingDirFromMirror` only ever force-updates the remote-tracking ref
 * `refs/remotes/origin/<branch>` on the distributed workingDir — it
 * deliberately never touches the local branch ref, because doing so used to
 * break the moment that branch was checked out in a linked worktree (e.g. a
 * task whose branch input names the base branch itself), causing every
 * later distribution to that server x repo to fail permanently. So whenever
 * distribution actually landed new content (`'distributed'` or
 * `'already_current'` — both mean the tracking ref is now known-good),
 * worktree creation must resolve from `origin/<baseBranch>`, not the
 * possibly-stale local `<baseBranch>`. Local/ssh servers, or isolated
 * servers where distribution did not run this call (`distStatus` is null),
 * keep resolving the plain `baseBranch` as before.
 *
 * `baseBranch` is normalized via `stripOriginPrefix()` before the `origin/`
 * prefix is applied, so an already-qualified value (pre-existing task data
 * from before `validateGitFields` rejected new `origin/`-prefixed input)
 * resolves to `origin/main`, not `origin/origin/main` (Issue #87 third-party
 * review, 10th round, Important finding 1).
 */
export function resolveWorktreeCreateBaseBranch(
  baseBranch: string,
  distStatus: 'distributed' | 'already_current' | 'failed' | null,
): string {
  return distStatus === 'distributed' || distStatus === 'already_current'
    ? `origin/${stripOriginPrefix(baseBranch)}`
    : baseBranch;
}
