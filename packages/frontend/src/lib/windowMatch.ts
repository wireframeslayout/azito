import { stripPaneSuffix } from '@azito/shared';
import type { Session, TmuxWindow, Window } from '../pages/workspace/types';
import { muxRefJson, parseTerminalTabId } from './terminalRef';

export interface SessionWindowMatch {
  session: Session;
  window: TmuxWindow;
}

type MatchableWindow = Pick<Window, 'id' | 'tmuxTarget' | 'label' | 'muxRef'>;

function matchesSpec(win: TmuxWindow, spec: string): boolean {
  const idx = parseInt(spec, 10);
  return Number.isNaN(idx) ? win.name === spec : win.index === idx;
}

/**
 * Finds the session window a registered window row stands for. Priority:
 * 1. windowId — the session listing carries `windowId` when a DB row exists (searched across sessions)
 * 2. muxRef — serialized JSON comparison (a misao window's target is not a tmux session:window pair)
 * 3. tmuxTarget `session:window[.pane]` split, then the row label — the tmux path
 */
export function findSessionWindow(w: MatchableWindow, sessions: Session[]): SessionWindowMatch | null {
  const refJson = muxRefJson(w.muxRef);
  for (const session of sessions) {
    const found = session.windows.find((win) => win.windowId === w.id || (refJson !== undefined && win.ref === refJson));
    if (found) return { session, window: found };
  }

  const colonIdx = w.tmuxTarget.indexOf(':');
  if (colonIdx < 0) return null;
  const session = sessions.find((s) => s.name === w.tmuxTarget.slice(0, colonIdx));
  if (!session) return null;

  const rest = w.tmuxTarget.slice(colonIdx + 1);
  // A window name may itself contain a dot, so the whole remainder is tried before the pane suffix is stripped.
  const specs = [rest, stripPaneSuffix(rest)];
  for (const spec of specs) {
    const win = session.windows.find((candidate) => matchesSpec(candidate, spec));
    if (win) return { session, window: win };
  }
  const byLabel = w.label ? session.windows.find((candidate) => candidate.name === w.label) : undefined;
  return byLabel ? { session, window: byLabel } : null;
}

function paneOrdinalOfTarget(target: string): number | null {
  const m = /\.(\d+)$/.exec(target);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Whether the active terminal tab shows the row identified by (`serverName`, `target`, `windowId`).
 * A windowId-form tab is matched by windowId (and, at pane level, the pane ordinal in `target`);
 * any other tab form keeps the exact legacy `terminal:<server>/<target>` comparison.
 */
export function isTerminalTabActive(
  activeTabId: string | null | undefined,
  serverName: string,
  target: string,
  level: 'window' | 'pane',
  windowId?: number,
): boolean {
  if (!activeTabId) return false;
  const parsed = parseTerminalTabId(activeTabId);
  if (parsed?.kind === 'windowId') {
    if (parsed.serverName !== serverName || windowId === undefined || parsed.windowId !== windowId) return false;
    if (level === 'window') return true;
    return parsed.pane === paneOrdinalOfTarget(target);
  }
  return activeTabId === `terminal:${serverName}/${target}`;
}
