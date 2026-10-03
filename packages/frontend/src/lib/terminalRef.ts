import { type MuxRef, type MuxDriverKind, formatMuxRef, formatWindowId, muxRefFromTmuxTarget, parseMuxRef, stripPaneSuffix, tmuxTargetFromMuxRef } from '@azito/shared';
import type { Session, TmuxWindow } from '../pages/workspace/types';

export type TerminalRef =
  | { kind: 'windowId'; serverName: string; windowId: number; pane: number }
  | { kind: 'ref'; serverName: string; ref: string; pane: number };

export type ConnectPaneFn = (refOrServerName: TerminalRef | string, targetOrProjectId?: string | number, projectId?: number) => void;

export interface LegacyTerminalTabId {
  kind: 'legacy';
  serverName: string;
  target: string;
  pane: number;
}

export type ParsedTerminalTabId = TerminalRef | LegacyTerminalTabId;

export function terminalTabId(r: TerminalRef): string {
  if (r.kind === 'windowId') {
    return `terminal:${r.serverName}::w${r.windowId}.${r.pane}`;
  }
  return `terminal:${r.serverName}::ref:${encodeURIComponent(r.ref)}.${r.pane}`;
}

export function parseTerminalTabId(id: string): ParsedTerminalTabId | null {
  if (!id.startsWith('terminal:')) return null;
  const rest = id.slice('terminal:'.length);

  const dcIdx = rest.indexOf('::');
  if (dcIdx >= 0) {
    const serverName = rest.slice(0, dcIdx);
    const after = rest.slice(dcIdx + 2);

    const wMatch = after.match(/^w(\d+)\.(\d+)$/);
    if (wMatch) {
      return { kind: 'windowId', serverName, windowId: parseInt(wMatch[1], 10), pane: parseInt(wMatch[2], 10) };
    }

    const refMatch = after.match(/^ref:(.+)\.(\d+)$/);
    if (refMatch) {
      return { kind: 'ref', serverName, ref: decodeURIComponent(refMatch[1]), pane: parseInt(refMatch[2], 10) };
    }

    return null;
  }

  const slashIdx = rest.indexOf('/');
  if (slashIdx < 0) return null;
  const serverName = rest.slice(0, slashIdx);
  const target = rest.slice(slashIdx + 1);
  const dotIdx = target.lastIndexOf('.');
  let pane = 1;
  let windowTarget = target;
  if (dotIdx >= 0) {
    const suffix = target.slice(dotIdx + 1);
    if (/^\d+$/.test(suffix)) {
      pane = parseInt(suffix, 10);
      windowTarget = target.slice(0, dotIdx);
    }
  }
  return { kind: 'legacy', serverName, target: windowTarget, pane };
}

export function terminalRefFromWindow(
  serverName: string,
  windowId: number | null,
  ref: string,
  pane: number,
): TerminalRef {
  if (windowId !== null) {
    return { kind: 'windowId', serverName, windowId, pane };
  }
  return { kind: 'ref', serverName, ref, pane };
}

/**
 * Convert a raw tmux target string (e.g. "azito:win--abc.2") to a TerminalRef
 * without sessions data. Uses formatMuxRef(muxRefFromTmuxTarget(...)) to produce
 * a valid JSON ref string, and extracts the pane suffix.
 */
export function terminalRefFromTarget(serverName: string, target: string, sessions?: Session[]): TerminalRef {
  // With sessions the server-provided windowId / ref wins; a misao window must never be turned into a tmux-kind ref.
  if (sessions) return terminalRefFromLegacyTarget(serverName, target, sessions);
  const stripped = stripPaneSuffix(target);
  let pane = 1;
  if (stripped !== target) {
    const dotIdx = target.lastIndexOf('.');
    if (dotIdx >= 0) {
      const suffix = target.slice(dotIdx + 1);
      if (/^\d+$/.test(suffix)) pane = parseInt(suffix, 10);
    }
  }
  try {
    const muxRef = muxRefFromTmuxTarget(stripped);
    return { kind: 'ref', serverName, ref: formatMuxRef(muxRef), pane };
  } catch {
    return { kind: 'ref', serverName, ref: formatMuxRef({ kind: 'tmux', workspace: '', window: stripped }), pane };
  }
}

/** The session window a `<session>:<window name or index>` target (no pane suffix) names, as reported by the server. */
function findSessionWindowByTarget(sessions: Session[], windowPart: string): TmuxWindow | null {
  const colonIdx = windowPart.indexOf(':');
  if (colonIdx < 0) return null;
  const sessionName = windowPart.slice(0, colonIdx);
  const winSpec = windowPart.slice(colonIdx + 1);
  for (const sess of sessions) {
    if (sess.name !== sessionName) continue;
    const win = sess.windows.find((w) => w.name === winSpec || String(w.index) === winSpec);
    if (win) return win;
  }
  return null;
}

/** The ref the server reported for the window a `<session>:<window>[.<pane>]` target names. */
export function findSessionWindowRef(sessions: Session[], target: string): string | null {
  return findSessionWindowByTarget(sessions, stripPaneSuffix(target))?.ref ?? null;
}

export function terminalRefFromLegacyTarget(
  serverName: string,
  target: string,
  sessions: Session[],
): TerminalRef {
  const dotIdx = target.lastIndexOf('.');
  let pane = 1;
  let windowPart = target;
  if (dotIdx >= 0) {
    const suffix = target.slice(dotIdx + 1);
    if (/^\d+$/.test(suffix)) {
      pane = parseInt(suffix, 10);
      windowPart = target.slice(0, dotIdx);
    }
  }

  const win = findSessionWindowByTarget(sessions, windowPart);
  if (win) {
    return win.windowId !== null
      ? { kind: 'windowId', serverName, windowId: win.windowId, pane }
      : { kind: 'ref', serverName, ref: win.ref, pane };
  }

  try {
    const muxRef = muxRefFromTmuxTarget(windowPart);
    return { kind: 'ref', serverName, ref: formatMuxRef(muxRef), pane };
  } catch {
    return { kind: 'ref', serverName, ref: formatMuxRef({ kind: 'tmux', workspace: '', window: windowPart }), pane };
  }
}

export function migrateLegacyTerminalTabs(
  tabIds: string[],
  sessionsByServer: Map<string, Session[]>,
): Map<string, string> {
  const result = new Map<string, string>();
  for (const id of tabIds) {
    const parsed = parseTerminalTabId(id);
    if (!parsed || parsed.kind !== 'legacy') continue;
    const sessions = sessionsByServer.get(parsed.serverName) ?? [];
    const ref = terminalRefFromLegacyTarget(parsed.serverName, `${parsed.target}`, sessions);
    const newRef: TerminalRef = ref.kind === 'windowId'
      ? { ...ref, pane: parsed.pane }
      : { ...ref, pane: parsed.pane };
    result.set(id, terminalTabId(newRef));
  }
  return result;
}

/**
 * Identity of the terminal connection a view opens. XTermView keys its connect effect on this, so a change of the ref
 * the connection is built from (a tmux-kind ref used before sessions arrived turning into a windowId) reconnects
 * even when `target` is unchanged.
 */
export function terminalConnectionKey(serverName: string, target: string, ref: TerminalRef | undefined): string {
  return `${serverName}|${target}|${ref ? terminalTabId(ref) : ''}`;
}

export function terminalWsParams(r: TerminalRef, cols: number, rows: number): Record<string, string> {
  if (r.kind === 'windowId') {
    return {
      server: r.serverName,
      windowId: String(r.windowId),
      pane: String(r.pane),
      cols: String(cols),
      rows: String(rows),
    };
  }
  return {
    server: r.serverName,
    ref: r.ref,
    pane: String(r.pane),
    cols: String(cols),
    rows: String(rows),
  };
}

export function windowApiPath(r: TerminalRef, action?: string): string {
  if (r.kind === 'windowId') {
    return action ? `/windows/${r.windowId}/${action}` : `/windows/${r.windowId}`;
  }
  return action
    ? `/servers/${r.serverName}/mux/windows/${encodeURIComponent(r.ref)}/${action}`
    : `/servers/${r.serverName}/mux/windows/${encodeURIComponent(r.ref)}`;
}

/** The request that kills the window of a ref: registered windows (windowId form) use DELETE, unregistered ones the mux POST route. */
export function windowKillRequest(r: TerminalRef): { path: string; method: 'DELETE' | 'POST' } {
  return { path: windowApiPath(r, 'kill'), method: r.kind === 'windowId' ? 'DELETE' : 'POST' };
}

export function paneApiPath(r: TerminalRef, action?: string): string {
  if (r.kind === 'windowId') {
    return action
      ? `/windows/${r.windowId}/panes/${r.pane}/${action}`
      : `/windows/${r.windowId}/panes/${r.pane}`;
  }
  return action
    ? `/servers/${r.serverName}/mux/windows/${encodeURIComponent(r.ref)}/panes/${r.pane}/${action}`
    : `/servers/${r.serverName}/mux/windows/${encodeURIComponent(r.ref)}/panes/${r.pane}`;
}

export function terminalRefDisplayLabel(r: TerminalRef): string {
  if (r.kind === 'windowId') return formatWindowId(r.windowId);
  try {
    const parsed = parseMuxRef(r.ref);
    return `${parsed.workspace}:${parsed.window}`;
  } catch {
    return r.ref;
  }
}

export function terminalRefMatchesWindow(r: TerminalRef, windowId: number): boolean {
  return r.kind === 'windowId' && r.windowId === windowId;
}

/**
 * A TerminalRef that can actually be addressed: a positive integer windowId or a
 * non-empty ref string, plus a positive integer pane. Guards against callers that
 * hand an object (or nothing) where a windows.id was expected — such a ref would
 * otherwise become the tab id `…::w[object Object].1` and loop on /ws forever.
 */
export function isValidTerminalRef(r: unknown): r is TerminalRef {
  if (!r || typeof r !== 'object') return false;
  const x = r as Partial<TerminalRef> & { windowId?: unknown; ref?: unknown };
  if (typeof x.serverName !== 'string' || !x.serverName) return false;
  if (typeof x.pane !== 'number' || !Number.isInteger(x.pane) || x.pane < 1) return false;
  if (x.kind === 'windowId') return typeof x.windowId === 'number' && Number.isInteger(x.windowId) && x.windowId > 0;
  if (x.kind === 'ref') return typeof x.ref === 'string' && x.ref.length > 0 && !x.ref.includes('[object ');
  return false;
}

/**
 * The tmux target string (`<session>:<window>.<pane>`) a TerminalRef currently maps to, or
 * null when it cannot be derived yet (windowId form whose window is not in `sessions`).
 * Consumers that still key off a tmux target (window-exists check, WindowStatusDropdown,
 * pane-loading-state fallback) use this instead of the `w<id>` placeholder connectPane stores.
 */
export function resolveTerminalTarget(r: TerminalRef, sessions: Session[] | undefined): string | null {
  if (r.kind === 'ref') {
    try {
      const muxRef = parseMuxRef(r.ref);
      // A misao ref carries a window id, not a name: take the name from sessions (null until the window is listed).
      if (muxRef.kind === 'misao') return findSessionWindow(sessions, (w) => sameMisaoWindow(w.ref, muxRef.window), r.pane);
      return `${tmuxTargetFromMuxRef(muxRef)}.${r.pane}`;
    } catch {
      return null;
    }
  }
  return findSessionWindow(sessions, (w) => w.windowId === r.windowId, r.pane);
}

function sameMisaoWindow(ref: string, windowId: string): boolean {
  const parsed = parseMuxRef(ref);
  return parsed.kind === 'misao' && parsed.window === windowId;
}

function findSessionWindow(sessions: Session[] | undefined, match: (w: Session['windows'][number]) => boolean, pane: number): string | null {
  for (const sess of sessions ?? []) {
    const win = sess.windows.find(match);
    if (win) return `${sess.name}:${win.name}.${pane}`;
  }
  return null;
}

/**
 * Recover a TerminalRef from a persisted tab `target` when the tab carries no terminalRef:
 * `w<id>` (what connectPane stores for windowId tabs) → windowId form, a real tmux target →
 * ref form, anything else → null.
 */
export function terminalRefFromTabTarget(serverName: string, target: string, sessions?: Session[]): TerminalRef | null {
  const m = /^w(\d+)(?:\.(\d+))?$/.exec(target);
  if (m) return { kind: 'windowId', serverName, windowId: parseInt(m[1], 10), pane: m[2] ? parseInt(m[2], 10) : 1 };
  if (target.includes(':')) return terminalRefFromTarget(serverName, target, sessions);
  return null;
}

/**
 * The ref to register an untracked window with. A tmux server keeps the original behaviour (the ref is built from the
 * tmux target). Any other mux kind never gets a tmux ref synthesised: it uses the ref the terminal was opened with, or
 * the one the server reported in sessions, and is null (not registrable yet) when neither is available.
 */
export function resolveWindowRegistrationRef(opts: {
  muxKind: MuxDriverKind | undefined;
  target: string;
  terminalRef?: TerminalRef;
  sessions?: Session[];
}): string | null {
  const { muxKind, target, terminalRef, sessions } = opts;
  if (muxKind === 'tmux') {
    try { return formatMuxRef(muxRefFromTmuxTarget(stripPaneSuffix(target))); } catch { return null; }
  }
  if (terminalRef?.kind === 'ref') return terminalRef.ref;
  return sessions ? findSessionWindowRef(sessions, target) : null;
}

/** The tab a just-registered window opens as: the id the registration API returned, never a ref rebuilt from the target. */
export function registeredWindowTerminalRef(serverName: string, windowId: number): TerminalRef {
  return { kind: 'windowId', serverName, windowId, pane: 1 };
}

/**
 * A window row's `muxRef` as the JSON string every ref consumer compares and sends. The server returns it as a MuxRef
 * object, so it must be normalised before any `===` against a TerminalRef / TmuxWindow ref string.
 */
export function muxRefJson(ref: MuxRef | undefined): string | undefined {
  return ref ? formatMuxRef(ref) : undefined;
}

/**
 * Whether a ref-form terminal tab shows the window a window row's `target` names. A tmux ref is compared with the ref
 * built from the target; a misao row stores `<workspace>:<window id>` (the target of a ref-only registration).
 * A window registered with a window-name target cannot be matched this way — it carries a windowId tab instead.
 */
export function refTabMatchesTarget(tabRef: string, target: string): boolean {
  try {
    const parsedRef = parseMuxRef(tabRef);
    const windowTarget = stripPaneSuffix(target);
    if (parsedRef.kind === 'misao') return windowTarget === `${parsedRef.workspace}:${parsedRef.window}`;
    return tabRef === formatMuxRef(muxRefFromTmuxTarget(windowTarget));
  } catch {
    return false;
  }
}
