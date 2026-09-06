import { formatMuxRef, muxRefFromTmuxTarget, parseMuxRef, stripPaneSuffix } from '@azito/shared';
import type { Session } from '../pages/workspace/types';

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
export function terminalRefFromTarget(serverName: string, target: string): TerminalRef {
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

  const colonIdx = windowPart.indexOf(':');
  if (colonIdx >= 0) {
    const sessionName = windowPart.slice(0, colonIdx);
    const winSpec = windowPart.slice(colonIdx + 1);
    for (const sess of sessions) {
      if (sess.name !== sessionName) continue;
      for (const win of sess.windows) {
        if (win.name === winSpec || String(win.index) === winSpec) {
          if (win.windowId !== null) {
            return { kind: 'windowId', serverName, windowId: win.windowId, pane };
          }
          return { kind: 'ref', serverName, ref: win.ref, pane };
        }
      }
    }
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
  if (r.kind === 'windowId') return `w${r.windowId}`;
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
