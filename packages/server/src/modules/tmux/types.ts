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

export interface TmuxPaneInfo {
  paneId: string;
  sessionName: string;
  windowIndex: number;
  windowName: string;
  paneIndex: number;
  currentPath: string;
  currentCommand: string;
}
