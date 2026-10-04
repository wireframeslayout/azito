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
 * The mux of a window known only by its name/id string (a task's `tmuxWindow`, the window part of a `tmux_target`):
 * a misao window id (`w_<ULID>`) is misao, anything else tmux. For references that carry no `mux_ref`: a server's
 * `defaultMux` says where NEW windows go, not which mux an existing string names (one local server hosts both).
 */
export function kindOfWindowName(window: string): MuxDriverKind {
  return isMisaoWindowId(window) ? 'misao' : 'tmux';
}

/** `kindOfWindowName` of the window part of `<workspace>:<window>` (a trailing `.<pane>` is not part of the window). */
export function kindOfWindowTarget(target: string): MuxDriverKind {
  const sep = target.indexOf(':');
  return kindOfWindowName(sep === -1 ? target : target.slice(sep + 1).replace(/\.\d+$/, ''));
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
