import { parseMuxRef, resolveWindowTitle, formatWindowTitleLine, type WindowTitleInput } from '@azito/shared';


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

/** Adapt activity rows to the shared window title input. */
export function activeWindowTitleInput(row: { windowId?: number; target: string; paneTitle?: string; paneName?: string; paneCommand?: string; label?: string; labelSource?: 'auto' | 'user'; taskTitle?: string; workerType?: string; windowType?: string }): WindowTitleInput {
  return { id: row.windowId, label: row.label, labelSource: row.labelSource, paneTitle: row.paneTitle || row.paneName, paneCommand: row.paneCommand, taskTitle: row.taskTitle, workerType: row.workerType, windowType: row.windowType, tmuxTarget: row.target };
}

export interface ActivityTitleData {
  windowById: Map<number, WindowIndexEntry>;
  tasks: Array<{ id: number; title: string }>;
}

export function resolveActivityTitle(row: Parameters<typeof activeWindowTitleInput>[0] & { taskId?: number }, data?: ActivityTitleData): string {
  const win = row.windowId == null ? undefined : data?.windowById.get(row.windowId);
  const task = data?.tasks.find((t) => t.id === (win?.taskId ?? row.taskId));
  return formatWindowTitleLine(resolveWindowTitle(activeWindowTitleInput({
    ...row,
    label: win?.label ?? row.label,
    labelSource: win?.labelSource ?? row.labelSource,
    workerType: win?.workerType ?? row.workerType,
    windowType: win?.windowType ?? row.windowType,
    taskTitle: task?.title ?? row.taskTitle,
  })));
}
