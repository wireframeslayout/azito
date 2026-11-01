import { parseMuxRef, resolveWindowTitle, formatWindowTitle } from '@azito/shared';
export { resolveWindowTitle, formatWindowTitle } from '@azito/shared';
export { resolvePaneDisplayTitle } from '@azito/shared';
export type { WindowTitleInput as WindowDisplayInput, WindowTitle as WindowDisplay } from '@azito/shared';


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
 * ActiveWindowRow (稼働中ウィンドウ行) のフィールドから表示ラベルを組み立てる。
 * `paneName` をペインタイトルとして `resolveWindowTitle` に渡し、
 * `formatWindowTitle` で「表示名 · W-123」形式に整形する。
 */
export function formatActiveWindowLabel(row: {
  windowId?: number;
  label?: string;
  labelSource?: 'auto' | 'user';
  paneName?: string;
  paneTitle?: string;
  paneCommand?: string;
  taskTitle?: string;
  workerType?: string;
  windowType?: string;
  target?: string;
}): string {
  const display = resolveWindowTitle({
    windowId: row.windowId,
    paneTitle: row.paneTitle ?? row.paneName,
    paneCommand: row.paneCommand,
    label: row.label,
    labelSource: row.labelSource,
    taskTitle: row.taskTitle,
    workerType: row.workerType,
    windowType: row.windowType,
    tmuxTarget: row.target,
  });
  return formatWindowTitle(display);
}

/**
 * Label of a window in a session list. A misao window is addressed by its own id and named on its own, so only the
 * window name is shown; a tmux window keeps `<session>:<window>`.
 */
export function sessionWindowLabel(sessionName: string, win: { name: string; ref: string }): string {
  return parseMuxRef(win.ref).kind === 'misao' ? win.name : `${sessionName}:${win.name}`;
}
