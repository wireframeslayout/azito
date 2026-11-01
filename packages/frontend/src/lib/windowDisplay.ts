import { isMisaoWindowId, stripPaneSuffix, parseMuxRef, resolveWindowTitle, formatWindowTitleLine, type WindowTitleInput } from '@azito/shared';
import type { Session } from '../pages/workspace/types';


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
export function activeWindowTitleInput(row: { windowId?: number; target: string; paneTitle?: string; paneName?: string; paneCommand?: string; label?: string | null; labelSource?: 'auto' | 'user'; taskTitle?: string; workerType?: string; windowType?: string }): WindowTitleInput {
  return { id: row.windowId, label: row.label, labelSource: row.labelSource, paneTitle: row.paneTitle ?? row.paneName, paneCommand: row.paneCommand, taskTitle: row.taskTitle, workerType: row.workerType, windowType: row.windowType, tmuxTarget: row.target };
}

/** Resolve an unregistered misao ref within one server's sessions. */
export function misaoRefWindowTitle(sessions: Session[], ref: string, pane: number, fallback: string): string {
  const match = sessions.flatMap((session) => session.windows.map((window) => ({ session, window })))
    .find(({ window }) => window.ref === ref);
  const name = match ? sessionWindowLabel(match.session.name, match.window) : fallback;
  const display = resolveWindowTitle({ label: name, tmuxTarget: fallback });
  const suffix = match && match.window.panes.length > 1 ? `.${pane}` : '';
  return `${formatWindowTitleLine(display)}${suffix}`;
}

export function isMisaoTarget(target: string): boolean {
  return isMisaoWindowId(stripPaneSuffix(target).split(':').pop() ?? '');
}

export function windowTitleInput(w: { id?: number; label?: string | null; labelSource?: 'auto' | 'user'; workerType?: string | null; windowType?: string }): WindowTitleInput {
  return { id: w.id, label: w.label ?? undefined, labelSource: w.labelSource, workerType: w.workerType ?? undefined, windowType: w.windowType };
}
