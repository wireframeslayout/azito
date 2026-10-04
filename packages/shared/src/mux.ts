import { stripPaneSuffix, windowKey } from './windowKey';

export type MuxDriverKind = 'tmux' | 'misao';

/** Which tmux binary a server runs: the system one or the hub-managed one. Unrelated to the mux kind (`MuxDriverKind`). */
export type MuxRuntime = 'system' | 'managed';

export interface MuxRef {
  kind: MuxDriverKind;
  workspace: string;
  window: string;
}

export type PaneHandle = string & { readonly __brand: 'PaneHandle' };

export type PaneOrdinal = number;

export interface MuxCapabilities {
  changeEvents: boolean;
  agentState: boolean;
  independentClients: boolean;
  copyMode: boolean;
}

/** Process state a driver reports for a pane. Only the misao driver sets it (tmux panes do not carry it). */
export type MuxPaneProcessState = 'running' | 'exited' | 'stopped' | 'unknown';

/** Terminal WebSocket close codes and reasons the hub uses to say why a pane cannot be attached. */
export const TERMINAL_CLOSE = {
  windowNotFound: { code: 4404, reason: 'window not found' },
  paneStopped: { code: 4410, reason: 'pane stopped' },
  windowEmpty: { code: 4412, reason: 'window empty' },
  /** The pane the terminal was attached to was closed. The browser must not reconnect: pane numbers shift, so the same ordinal may now be another pane. */
  paneClosed: { code: 4413, reason: 'pane closed' },
} as const;

export interface MuxPane {
  index: number;
  /** The pane's stable handle (tmux `%<n>`, misao `p_<ULID>`): unlike `index` it does not shift when a sibling is deleted. */
  handle?: string;
  command: string;
  title: string;
  width: number;
  height: number;
  active: boolean;
  pid: number;
  /** Set by drivers that know the pane's process state (misao). Omitted = the driver does not report it. */
  processState?: MuxPaneProcessState;
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

/** A mux kind a server could not serve in a merged listing, and why (`reason` is a driver-unavailable code or `driver_error`). */
export interface MuxUnavailableKind {
  kind: MuxDriverKind;
  reason: string;
  detail?: string;
}

export interface MuxWorkspace {
  /** Stamped by the routing driver: which mux the workspace lives in. Same-named workspaces can exist in two muxes. */
  kind?: MuxDriverKind;
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
  /** Driver-precomputed ref of the pane's window. Matching against a window's ref uses it when present (see paneInfoMatchesRef). */
  ref?: MuxRef;
}

export type MuxExecRequest = { kind: 'tmux'; args: string[] };

export function asPaneHandle(s: string): PaneHandle {
  return s as PaneHandle;
}

export function formatMuxRef(ref: MuxRef): string {
  return JSON.stringify({ kind: ref.kind, workspace: ref.workspace, window: ref.window });
}

// Same ULID alphabet as misao's protocol primitives.ts (shared has no dependencies, so it is duplicated).
const MISAO_ULID = '[0-7][0-9A-HJKMNP-TV-Z]{25}';
const MISAO_WINDOW_ID_RE = new RegExp(`^w_${MISAO_ULID}$`);
/** A misao pane id: `p_` + ULID. A pane handle that does not match is a tmux one. */
export const MISAO_PANE_ID_PREFIX = 'p_';
export const MISAO_PANE_ID_RE = new RegExp(`^${MISAO_PANE_ID_PREFIX}${MISAO_ULID}$`);

export function isMisaoWindowId(s: string): boolean {
  return MISAO_WINDOW_ID_RE.test(s);
}

export function parseMuxRef(json: string): MuxRef {
  const obj = JSON.parse(json) as { kind: string; workspace: string; window: string };
  if (obj.kind === 'misao') {
    if (typeof obj.window !== 'string' || !MISAO_WINDOW_ID_RE.test(obj.window)) {
      throw new Error(`Invalid misao window id: ${obj.window}`);
    }
    return { kind: 'misao', workspace: obj.workspace, window: obj.window };
  }
  if (obj.kind !== 'tmux') {
    throw new Error(`Unsupported MuxRef kind: ${obj.kind}`);
  }
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
  if (ref.kind !== 'tmux') {
    throw new Error(`Cannot derive a tmux target from a ${ref.kind} MuxRef`);
  }
  return `${ref.workspace}:${ref.window}`;
}

export function windowKeyForRef(serverName: string, ref: MuxRef): string {
  if (ref.kind === 'misao') return windowKey(serverName, ref.window);
  return windowKey(serverName, tmuxTargetFromMuxRef(ref));
}

const TMUX_PANE_HANDLE_RE = /^%\d+$/;
export function isPaneHandleLike(s: string, kind: MuxDriverKind): boolean {
  return (kind === 'misao' ? MISAO_PANE_ID_RE : TMUX_PANE_HANDLE_RE).test(s);
}


/** The mux kind that owns a pane handle, told by its shape (misao `p_<ULID>`; anything else is tmux's). */
export function muxKindOfPaneHandle(handle: string): MuxDriverKind {
  return MISAO_PANE_ID_RE.test(handle) ? 'misao' : 'tmux';
}

/** True when `s` has the shape of a pane handle of any known mux kind (tmux `%<n>`, misao `p_<ULID>`). */
export function isPaneHandle(s: string): boolean {
  return isPaneHandleLike(s, 'tmux') || isPaneHandleLike(s, 'misao');
}
