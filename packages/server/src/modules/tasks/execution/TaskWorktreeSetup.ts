import type { ITaskRepository, Task } from '../Task';
import type { LogType } from '../ExecutionLog';
import type { ServerConfig } from '../../servers/Server';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import type { WorktreeServiceFactory } from '../../git/WorktreeServiceFactory';
import type { IContentExtractor } from '../../llm/ContentExtractor';
import type { WorktreeInfo } from '../../git/IWorktreeService';
import { assertDirectoryContained } from '../../git/PathContainment';
import { normalizeBranchRef } from '../../git/assertSafeGitArgs';
import { ensureGitIdentity, type GitIdentity } from '../../git/ensureGitIdentity';
import { ensureClaudeTrust } from '../../agents/claude/ensureClaudeTrust';
import { ensureCodexTrust } from '../../agents/codex/ensureCodexTrust';
import type { LocalAgentHomes } from '../../agents/agentHomes';
import { resolveWorktreeCreateBaseBranch } from './TaskExecutionEnv';

/** What a task's worktree step needs from the use case that runs it (the collaborators, not the use case itself). */
export interface TaskWorktreeDeps {
  taskRepo: Pick<ITaskRepository, 'update'>;
  contentExtractor: IContentExtractor;
  transportFactory: TransportFactory;
  worktreeServiceFactory: WorktreeServiceFactory;
  hubGitIdentity: GitIdentity | null;
  /** Where the hub's own machine keeps codex's config (`CODEX_HOME`); resolved once at the composition root. */
  localHomes: LocalAgentHomes;
  appendLog(taskId: number, unitId: number, type: LogType, content: unknown): void;
}

export interface TaskWorktreeRequest {
  server: ServerConfig;
  task: Pick<Task, 'id' | 'title' | 'branch'>;
  unitId: number;
  workerType: string | null;
  /** The directory the worktree is made from (the task's working directory). */
  workingDir: string;
  /** The project's configured working directory: the boundary the worktree must stay inside; null when there is none. */
  allowedRoot: string | null;
  baseBranch: string;
  distStatus: 'distributed' | 'already_current' | null;
  /** The slug of the branch name, made before this step by a caller that must not wait for the LLM inside a lock; null: made here. */
  slug: string | null;
}

/**
 * What a failure of the step leaves to be undone by the caller, which knows what it has created by then: `worktree_creation_failed_rollback`
 * (no worktree exists), `worktree_path_rejected_rollback` (the worktree was removed and the task's worktree fields must be cleared).
 */
export type TaskWorktreeFailure =
  | { reason: 'worktree_creation_failed_rollback'; message: string }
  | { reason: 'worktree_path_rejected_rollback'; message: string };

/** The step failed and the caller's `onFailure` has run; the message is what the use case answers with. */
export class TaskWorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskWorktreeError';
  }
}

/**
 * The worktree of a task, made the way a task's first run makes it: create it, check it stays inside the project's directory,
 * save it on the task, give it the hub's git identity and (Claude) trust its directory. A POSIX host runs this after the task's window
 * is created, a Windows host before (the window starts in the worktree, so it must exist first): `onFailure` is where the caller
 * undoes what it had created by then, and the step then throws a {@link TaskWorktreeError}.
 */
export async function createTaskWorktree(
  deps: TaskWorktreeDeps,
  request: TaskWorktreeRequest,
  onFailure: (failure: TaskWorktreeFailure) => Promise<void>,
): Promise<WorktreeInfo> {
  const { server, task, unitId, workingDir, allowedRoot, baseBranch, distStatus } = request;
  const { taskRepo, transportFactory } = deps;
  const worktrees = deps.worktreeServiceFactory.create(transportFactory.getTransport(server));
  const worktreeCreateBaseBranch = resolveWorktreeCreateBaseBranch(baseBranch, distStatus);

  let wt: WorktreeInfo;
  try {
    const slug = request.slug ?? await deps.contentExtractor.generateSlug(task.title);
    // `task.branch` is a persisted value, not fresh API input: a fully-qualified ref saved before the API refused them is normalized
    // here, like the base branch.
    const branchName = task.branch ? normalizeBranchRef(task.branch) : undefined;
    wt = await worktrees.create(workingDir, task.id, slug, worktreeCreateBaseBranch, branchName);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.appendLog(task.id, unitId, 'command', { type: 'worktree_failed', message });
    await onFailure({ reason: 'worktree_creation_failed_rollback', message });
    throw new TaskWorktreeError(`Worktree creation failed: ${message}`);
  }

  if (allowedRoot) {
    try {
      // The resolved (symlink-free) path, not the one worktree creation returned, is what is saved and used from here on.
      const resolvedWtPath = await assertDirectoryContained(transportFactory.getFileOps(server), { target: wt.path, allowedRoot }, 'worktree path');
      wt = { ...wt, path: resolvedWtPath };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.appendLog(task.id, unitId, 'command', { type: 'worktree_path_rejected', message });
      // The worktree is on disk already: it is removed, and a failure to remove it is logged (it needs a person's attention).
      try {
        await worktrees.remove(workingDir, wt.path);
      } catch (cleanupErr) {
        deps.appendLog(task.id, unitId, 'command', { type: 'worktree_cleanup_failed', message: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr) });
      }
      await onFailure({ reason: 'worktree_path_rejected_rollback', message });
      throw new TaskWorktreeError(`Worktree path rejected: ${message}`);
    }
  }

  // `task.branch` is not written: it is hashed into the execution-gate fingerprint (`branches.work`), and writing the resolved branch
  // back would change the fingerprint the approval was granted under. `worktreeBranch` is the field for the branch the system resolved.
  taskRepo.update(task.id, { worktreePath: wt.path, worktreeBranch: wt.branch, baseBranch } as Partial<Task>);
  deps.appendLog(task.id, unitId, 'command', { type: 'worktree_created', worktreePath: wt.path, worktreeBranch: wt.branch, baseBranch });

  await applyGitIdentity(deps, server, task.id, unitId, wt.path);
  // On Windows both the project's directory and the worktree itself (see registerClaudeTrust): the worktree is a repository root of its own.
  if (request.workerType === 'claude') await registerClaudeTrust(deps, server, task.id, unitId, workingDir, wt.path);
  // codex looks the directory it runs in up first, so the worktree is what to register (the project's directory is not needed for it).
  if (request.workerType === 'codex') await registerCodexTrust(deps, server, task.id, unitId, wt.path);
  return wt;
}

async function applyGitIdentity(deps: TaskWorktreeDeps, server: ServerConfig, taskId: number, unitId: number, worktreePath: string): Promise<void> {
  try {
    const identityResult = await ensureGitIdentity(deps.transportFactory.getTransport(server), worktreePath, deps.hubGitIdentity);
    if (identityResult.action === 'applied') {
      deps.appendLog(taskId, unitId, 'command', { type: 'git_identity_applied', fields: identityResult.fields });
    } else if (identityResult.action === 'hub_missing') {
      deps.appendLog(taskId, unitId, 'command', { type: 'git_identity_missing' });
    }
  } catch (err) {
    deps.appendLog(taskId, unitId, 'command', { type: 'git_identity_failed', message: err instanceof Error ? err.message : String(err) });
  }
}

async function registerClaudeTrust(deps: TaskWorktreeDeps, server: ServerConfig, taskId: number, unitId: number, workingDir: string, worktreePath: string): Promise<void> {
  // (A POSIX host keeps registering the project's directory only.)
  const directories = deps.transportFactory.getFileOps(server).platform === 'win32' ? [workingDir, worktreePath] : [workingDir];
  for (const directory of directories) await registerClaudeTrustFor(deps, server, taskId, unitId, directory);
}

async function registerClaudeTrustFor(deps: TaskWorktreeDeps, server: ServerConfig, taskId: number, unitId: number, directory: string): Promise<void> {
  try {
    const transport = deps.transportFactory.getTransport(server);
    const resolvedWorkingDir = await transport.files().realpath(directory);
    const trustResult = await ensureClaudeTrust(transport, resolvedWorkingDir);
    if (trustResult.action === 'registered') {
      deps.appendLog(taskId, unitId, 'command', { type: 'claude_trust_registered', path: resolvedWorkingDir });
    } else if (trustResult.action === 'skipped') {
      deps.appendLog(taskId, unitId, 'command', { type: 'claude_trust_skipped', reason: trustResult.reason });
    } else if (trustResult.action === 'failed') {
      deps.appendLog(taskId, unitId, 'command', { type: 'claude_trust_failed', reason: trustResult.reason });
    }
  } catch (err) {
    deps.appendLog(taskId, unitId, 'command', { type: 'claude_trust_failed', reason: err instanceof Error ? err.message : String(err) });
  }
}

async function registerCodexTrust(deps: TaskWorktreeDeps, server: ServerConfig, taskId: number, unitId: number, worktreePath: string): Promise<void> {
  try {
    const transport = deps.transportFactory.getTransport(server);
    const resolved = await transport.files().realpath(worktreePath);
    const result = await ensureCodexTrust(transport, resolved, deps.localHomes, server.type === 'local');
    if (result.action === 'registered') {
      deps.appendLog(taskId, unitId, 'command', { type: 'codex_trust_registered', path: result.key });
    } else if (result.action === 'skipped') {
      deps.appendLog(taskId, unitId, 'command', { type: 'codex_trust_skipped', reason: result.reason });
    } else if (result.action === 'failed') {
      deps.appendLog(taskId, unitId, 'command', { type: 'codex_trust_failed', reason: result.reason });
    }
  } catch (err) {
    deps.appendLog(taskId, unitId, 'command', { type: 'codex_trust_failed', reason: err instanceof Error ? err.message : String(err) });
  }
}
