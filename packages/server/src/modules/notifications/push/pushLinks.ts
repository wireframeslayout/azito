export function taskPushUrl(projectId: number, taskId: number): string {
  return `/workspace/${projectId}?task=${taskId}`;
}

export function agentPushUrl(opts: {
  projectId?: number;
  serverName: string;
  target: string;
  windowId?: number;
}): string {
  const params = new URLSearchParams({ server: opts.serverName, target: opts.target });
  if (opts.windowId != null) params.set('windowId', String(opts.windowId));
  const base = opts.projectId != null ? `/workspace/${opts.projectId}` : '/';
  return `${base}?${params}`;
}

/** The push URL for an `agent:activity` event: carries the windowId so a window opens by id, with the project from the event or its task. */
export function agentActivityPushUrl(
  payload: { serverName: string; target: string; windowId?: number; projectId?: number; taskId?: number },
  projectIdOfTask: (taskId: number) => number | undefined,
): string {
  const { serverName, target, windowId, taskId } = payload;
  const projectId = payload.projectId ?? (taskId != null ? projectIdOfTask(taskId) : undefined);
  return agentPushUrl({ projectId, serverName, target, windowId });
}
