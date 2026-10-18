const W_ID_RE = /^w(\d+)$/;

export function findTaskByTarget<T extends { id: number; tmuxWindow?: string }>(
  target: string,
  tasks: readonly T[],
  windowById: Map<number, { taskId?: number }>,
): T | null {
  const wMatch = W_ID_RE.exec(target);
  if (wMatch) {
    const win = windowById.get(parseInt(wMatch[1], 10));
    if (win?.taskId != null) return tasks.find(t => t.id === win.taskId) ?? null;
    return null;
  }
  const parts = target.split(':');
  if (parts.length < 2) return null;
  const windowName = parts[1].split('.')[0];
  return tasks.find(t => t.tmuxWindow === windowName) ?? null;
}
