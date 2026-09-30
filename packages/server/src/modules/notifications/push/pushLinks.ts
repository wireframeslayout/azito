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
