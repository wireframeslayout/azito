import type { Task } from '../Task';
import type { ProjectDetail } from '../../projects/Project';
import type { IProjectServerRepository } from '../../projects/ProjectServer';

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
