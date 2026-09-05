import { stripPaneSuffix, windowKey } from './windowKey';

export type MuxDriverKind = 'tmux';

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
}

export function asPaneHandle(s: string): PaneHandle {
  return s as PaneHandle;
}

export function formatMuxRef(ref: MuxRef): string {
  return JSON.stringify({ kind: ref.kind, workspace: ref.workspace, window: ref.window });
}

export function parseMuxRef(json: string): MuxRef {
  const obj = JSON.parse(json) as { kind: string; workspace: string; window: string };
  if (obj.kind !== 'tmux') {
    throw new Error(`Unknown MuxDriverKind: ${obj.kind}`);
  }
  return { kind: obj.kind, workspace: obj.workspace, window: obj.window };
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
