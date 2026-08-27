export function taskPushUrl(projectId: number, taskId: number): string {
  return `/workspace/${projectId}?task=${taskId}`;
}

export function agentPushUrl(opts: {
  projectId?: number;
  serverName: string;
  target: string;
}): string {
  const params = new URLSearchParams({ server: opts.serverName, target: opts.target });
  const base = opts.projectId != null ? `/workspace/${opts.projectId}` : '/';
  return `${base}?${params}`;
}
