import { stripPaneSuffix, windowKey } from './windowKey';

export type MuxDriverKind = 'tmux';

export type MuxRuntime = 'system' | 'managed';

export function muxKindForRuntime(runtime: MuxRuntime): MuxDriverKind {
  switch (runtime) {
    case 'system':
    case 'managed':
      return 'tmux';
  }
}

export interface MuxRef {
  kind: MuxDriverKind;
  workspace: string;
  window: string;
}

export type PaneHandle = string & { readonly __brand: 'PaneHandle' };

export type PaneOrdinal = number;

export interface MuxCapabilities {
  outputStream: boolean;
  changeEvents: boolean;
  agentState: boolean;
  independentClients: boolean;
  envInjection: boolean;
  zoom: boolean;
  copyMode: boolean;
  paneTitle: boolean;
  activityCounter: boolean;
  layoutSnapshot: boolean;
  stablePaneHandle: boolean;
}

export interface MuxPane {
  index: number;
  command: string;
  title: string;
  width: number;
  height: number;
  active: boolean;
  pid: number;
}

export interface MuxWindowInfo {
  index: number;
  name: string;
  active: boolean;
  panes: MuxPane[];
  activity: number;
  /** Driver-precomputed ref. When set, workspacesToSessions uses it instead of constructing one from workspace/window names. */
  ref?: MuxRef;
}

export interface MuxWorkspace {
  name: string;
  windowCount: number;
  attached: boolean;
  created: number;
  windows: MuxWindowInfo[];
}

export interface MuxPaneInfo {
  paneId: string;
  sessionName: string;
  windowIndex: number;
  windowName: string;
  paneIndex: number;
  currentPath: string;
  currentCommand: string;
}

export type MuxExecRequest = { kind: 'tmux'; args: string[] };

export function asPaneHandle(s: string): PaneHandle {
  return s as PaneHandle;
}

export function formatMuxRef(ref: MuxRef): string {
  return JSON.stringify({ kind: ref.kind, workspace: ref.workspace, window: ref.window });
}

export function parseMuxRef(json: string): MuxRef {
  const obj = JSON.parse(json) as { kind: string; workspace: string; window: string };
  return { kind: 'tmux', workspace: obj.workspace, window: obj.window };
}

export function muxRefFromTmuxTarget(target: string): MuxRef {
  const stripped = stripPaneSuffix(target);
  const colonIdx = stripped.indexOf(':');
  if (colonIdx === -1) {
    throw new Error(`Invalid tmux target (missing ":"): ${target}`);
  }
  return {
    kind: 'tmux',
    workspace: stripped.slice(0, colonIdx),
    window: stripped.slice(colonIdx + 1),
  };
}

export function tmuxTargetFromMuxRef(ref: MuxRef): string {
  return `${ref.workspace}:${ref.window}`;
}

export function windowKeyForRef(serverName: string, ref: MuxRef): string {
  return windowKey(serverName, tmuxTargetFromMuxRef(ref));
}

const PANE_HANDLE_LIKE_RE = /^%\d+$/;
export function isPaneHandleLike(s: string): boolean {
  return PANE_HANDLE_LIKE_RE.test(s);
}

