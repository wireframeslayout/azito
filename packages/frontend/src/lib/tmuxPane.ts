import type { Pane, Session, TmuxWindow } from '../pages/workspace/types';

export function paneDisplayName(pane: Pick<Pane, 'title' | 'command'>): string {
  return pane.title && pane.title !== pane.command ? pane.title : pane.command;
}

function findWindow(sessions: Session[], sessionName: string, spec: string): TmuxWindow | undefined {
  const session = sessions.find((s) => s.name === sessionName);
  if (!session) return undefined;
  return session.windows.find((w) => w.name === spec) ??
    session.windows.find((w) => String(w.index) === spec);
}

export function resolveActivePane(
  sessions: Session[],
  target: string,
): Pane | null {
  const colonIdx = target.indexOf(':');
  if (colonIdx < 0) return null;
  const sessionName = target.slice(0, colonIdx);
  const rest = target.slice(colonIdx + 1);

  // 2-pass: try the raw spec first (supports window names containing dots
  // like "foo.1"), fall back to dot-split only when the raw spec doesn't match.
  let win = findWindow(sessions, sessionName, rest);
  let paneIdx: number | null = null;

  if (!win) {
    const dotIdx = rest.lastIndexOf('.');
    if (dotIdx >= 0) {
      const stripped = rest.slice(0, dotIdx);
      const suffix = rest.slice(dotIdx + 1);
      win = findWindow(sessions, sessionName, stripped);
      if (win && /^\d+$/.test(suffix)) paneIdx = parseInt(suffix, 10);
    }
  }
  if (!win) return null;

  const activePane = win.panes.find((p) => p.active);
  if (activePane) return activePane;

  if (paneIdx !== null) {
    const targeted = win.panes.find((p) => p.index === paneIdx);
    if (targeted) return targeted;
  }

  return win.panes[0] ?? null;
}
