import { parseMuxRef } from '@azito/shared';
export { resolveWindowTitle, formatWindowTitleLine } from '@azito/shared';
export { resolvePaneDisplayTitle } from '@azito/shared';


export interface WindowIndexEntry {
  id: number;
  serverName: string;
  tmuxTarget: string;
  label?: string;
  labelSource?: 'auto' | 'user';
  workerType?: string;
  windowType?: string;
  taskId?: number;
}

export function buildWindowIndex<T extends WindowIndexEntry>(
  allProjects: Array<{ windows?: T[] }>,
  allTasks: Array<{ windows?: T[] }>,
  currentProject?: { windows: T[] } | null,
): Map<number, T> {
  const map = new Map<number, T>();
  for (const p of allProjects) {
    for (const w of p.windows ?? []) map.set(w.id, w);
  }
  for (const t of allTasks) {
    for (const w of t.windows ?? []) map.set(w.id, w);
  }
  if (currentProject) {
    for (const w of currentProject.windows) map.set(w.id, w);
  }
  return map;
}

/**
 * Label of a window in a session list. A misao window is addressed by its own id and named on its own, so only the
 * window name is shown; a tmux window keeps `<session>:<window>`.
 */
export function sessionWindowLabel(sessionName: string, win: { name: string; ref: string }): string {
  return parseMuxRef(win.ref).kind === 'misao' ? win.name : `${sessionName}:${win.name}`;
}
