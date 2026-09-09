import type { MuxWorkspace, MuxWindowInfo, MuxPane, MuxPaneInfo, MuxRef } from '@azito/shared';

export type { MuxWorkspace, MuxWindowInfo, MuxPane, MuxPaneInfo };

export interface TmuxPane {
  index: number;
  command: string;
  title: string;
  width: number;
  height: number;
  active: boolean;
  pid: number;
}

export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
  panes: TmuxPane[];
  activity: number;
  /** Present only for non-tmux mux drivers (herdr/zellij) whose session structure differs from tmux. */
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
