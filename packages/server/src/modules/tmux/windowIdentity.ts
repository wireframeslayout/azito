import { isMisaoWindowId, muxRefFromTmuxTarget, type MuxDriverKind, type MuxRef } from '@azito/shared';

/** The fields of a window row these helpers read (structural, so this base module does not import the windows module). */
export interface WindowRowIdentity {
  muxRef?: MuxRef;
  tmuxTarget: string;
  label?: string | null;
}

/**
 * Where a window's identity lives. A window row keeps its stable identity in `mux_ref` (misao: the window id
 * `w_<ULID>`; tmux: the window name) and its human-readable name in `label`. `task.tmuxWindow` holds the same
 * identity string as `mux_ref.window`. Whether two references are the same window is decided from the ref
 * (and, for liveness, `driver.windowExists(ref)`), never by comparing display names.
 */

/** The mux kind a window row lives in: its `mux_ref` kind (rows that predate `mux_ref` are tmux). */
export function windowKindOf(win: Pick<WindowRowIdentity, 'muxRef'>): MuxDriverKind {
  return win.muxRef?.kind ?? 'tmux';
}

/**
 * The mux of STORED window data (a window row, a task's `tmuxWindow`): its `mux_ref` kind, and tmux when there is
 * none. Migration 078 gave every misao row a `mux_ref`, so data without one predates misao. A `w_<ULID>` string is
 * NOT evidence of misao here: it is a valid tmux window name too. A server's `defaultMux` says where NEW windows
 * go, not which mux existing data lives in (one local server hosts both).
 */
export function kindOfStoredWindow(win: Pick<WindowRowIdentity, 'muxRef'> | undefined): MuxDriverKind {
  return win?.muxRef?.kind ?? 'tmux';
}

/** The ref of a window row: its `mux_ref`, or the one derived from `tmux_target` for rows that predate `mux_ref`. */
export function windowRefOf(win: Pick<WindowRowIdentity, 'muxRef' | 'tmuxTarget'>, kind: MuxDriverKind): MuxRef {
  return win.muxRef ?? { ...muxRefFromTmuxTarget(win.tmuxTarget), kind };
}

/**
 * The ref of a task's current window. misao: the primary window row's ref (its `mux_ref` is the identity, and
 * `task.tmuxWindow` can lag behind or hold a display name). tmux: built from `task.tmuxWindow` in `workspace`,
 * as before — unless `tmuxPrefersPrimary` is set for a caller that already read the primary row first. Null
 * when the task has no window at all.
 */
export function taskWindowRef(
  task: { tmuxWindow?: string | null },
  primaryWindow: Pick<WindowRowIdentity, 'muxRef' | 'tmuxTarget'> | undefined,
  workspace: string,
  kind: MuxDriverKind,
  opts?: { tmuxPrefersPrimary?: boolean },
): MuxRef | null {
  if (primaryWindow && (kind === 'misao' || opts?.tmuxPrefersPrimary)) return windowRefOf(primaryWindow, kind);
  return task.tmuxWindow ? { kind, workspace, window: task.tmuxWindow } : null;
}

/** misao: the window id decides (a window can move between workspaces); tmux: workspace and window name. */
export function isSameWindow(a: MuxRef, b: MuxRef): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'misao') return a.window === b.window;
  return a.workspace === b.workspace && a.window === b.window;
}

/**
 * The name to open a re-created window with. A misao window row's label is its display name; a label that
 * is itself a window id (rows written before labels were separated from ids) is not one.
 */
export function windowDisplayName(win: Pick<WindowRowIdentity, 'label'>): string | undefined {
  const label = win.label?.trim();
  return label && !isMisaoWindowId(label) ? label : undefined;
}
