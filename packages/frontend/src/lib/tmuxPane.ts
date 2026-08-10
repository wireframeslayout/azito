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

// 2-pass: try the raw spec first (supports window names containing dots like
// "foo.1"), fall back to dot-split only when the raw spec doesn't match. Shared
// by resolveActivePane (below) and any caller that only needs the live tmux
// window (e.g. its current pane count) rather than a specific pane — see
// TaskPanel's SP window bar ("▣ win ▾ Nペイン", Issue #69 T5).
export function resolveTmuxWindow(sessions: Session[], target: string): TmuxWindow | null {
  const colonIdx = target.indexOf(':');
  if (colonIdx < 0) return null;
  const sessionName = target.slice(0, colonIdx);
  const rest = target.slice(colonIdx + 1);

  const win = findWindow(sessions, sessionName, rest);
  if (win) return win;

  const dotIdx = rest.lastIndexOf('.');
  if (dotIdx < 0) return null;
  return findWindow(sessions, sessionName, rest.slice(0, dotIdx)) ?? null;
}

export function resolveActivePane(
  sessions: Session[],
  target: string,
): Pane | null {
  const win = resolveTmuxWindow(sessions, target);
  if (!win) return null;

  const activePane = win.panes.find((p) => p.active);
  if (activePane) return activePane;

  const colonIdx = target.indexOf(':');
  const rest = colonIdx >= 0 ? target.slice(colonIdx + 1) : '';
  const dotIdx = rest.lastIndexOf('.');
  if (dotIdx >= 0) {
    const suffix = rest.slice(dotIdx + 1);
    if (/^\d+$/.test(suffix)) {
      const pIdx = parseInt(suffix, 10);
      const targeted = win.panes.find((p) => p.index === pIdx);
      if (targeted) return targeted;
    }
  }

  return win.panes[0] ?? null;
}
