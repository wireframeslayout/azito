/**
 * The server a task executes on: the task's own `serverName`; when absent, the project's single server, and only if
 * exactly one exists. Zero (nothing to run on) or two or more (ambiguous) is null. The hub resolves the task's server
 * with this (`resolveTaskServerName`) and the UI judges host features with the same rule, so the two cannot drift.
 */
export function pickTaskExecutionServer(taskServerName: string | null | undefined, projectServerNames: readonly string[]): string | null {
  if (taskServerName) return taskServerName;
  return projectServerNames.length === 1 ? projectServerNames[0] : null;
}
