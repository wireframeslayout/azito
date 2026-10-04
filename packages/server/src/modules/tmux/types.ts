import { muxKindOfPaneHandle, type MuxWorkspace, type MuxWindowInfo, type MuxPane, type MuxPaneInfo, type MuxRef } from '@azito/shared';

export type { MuxWorkspace, MuxWindowInfo, MuxPane, MuxPaneInfo };

export interface TmuxPane {
  index: number;
  command: string;
  title: string;
  width: number;
  height: number;
  active: boolean;
  pid: number;
  /** tmux `%<n>` pane id: stable across sibling deletion, unlike `index`. */
  handle?: string;
}

export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
  panes: TmuxPane[];
  activity: number;
  /** Present only for non-tmux mux drivers whose session structure differs from tmux. */
  ref?: MuxRef;
}

export interface TmuxSession {
  name: string;
  windowCount: number;
  attached: boolean;
  created: number;
  windows: TmuxWindow[];
}

/**
 * True when `windowSpec` identifies a window by its tmux index (numeric) or
 * name.  A trailing `.digits` may be a pane suffix or part of the window name
 * itself (e.g. a window literally named `foo.1`), so both the raw and the
 * pane-stripped forms of the spec are tried.
 * An empty spec matches nothing — session-only targets are the caller's call.
 */
export function windowSpecMatches(windowSpec: string, windowIndex: number, windowName: string): boolean {
  for (const spec of new Set([windowSpec, windowSpec.replace(/\.\d+$/, '')])) {
    if (!spec) continue;
    if (/^\d+$/.test(spec) ? spec === String(windowIndex) : spec === windowName) return true;
  }
  return false;
}

export interface TmuxPaneInfo {
  paneId: string;
  sessionName: string;
  windowIndex: number;
  windowName: string;
  paneIndex: number;
  currentPath: string;
  currentCommand: string;
}

/**
 * True when the pane belongs to the window `ref` addresses. misao compares window ids; a pane without a ref never
 * matches a misao ref. A tmux ref matches tmux panes only: a merged listing also holds misao panes, whose workspace
 * and window index/name can equal a tmux window's. A pane's kind is its ref's, else its handle's shape.
 */
export function paneInfoMatchesRef(pane: MuxPaneInfo, ref: MuxRef): boolean {
  if (ref.kind === 'misao') return pane.ref?.kind === 'misao' && pane.ref.window === ref.window;
  const paneKind = pane.ref?.kind ?? muxKindOfPaneHandle(pane.paneId);
  return paneKind === 'tmux' && pane.sessionName === ref.workspace && windowSpecMatches(ref.window, pane.windowIndex, pane.windowName);
}

/** True when `win` (already known to be in the ref's workspace) is the window `ref` addresses; a tmux ref matches tmux windows only. */
export function windowInfoMatchesRef(win: MuxWindowInfo, ref: MuxRef): boolean {
  if (ref.kind === 'misao') return win.ref?.kind === 'misao' && win.ref.window === ref.window;
  return (win.ref?.kind ?? 'tmux') === 'tmux' && windowSpecMatches(ref.window, win.index, win.name);
}
