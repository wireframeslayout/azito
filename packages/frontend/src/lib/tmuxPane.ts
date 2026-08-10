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

interface WindowMatch {
  window: TmuxWindow;
  /** true = resolved via a raw-target match (e.g. a window literally named "foo.1"). false =
   *  resolved only after stripping a trailing ".N" and re-matching (the dot was a pane suffix). */
  matchedRaw: boolean;
}

// 2-pass: try the raw spec first (supports window names containing dots like
// "foo.1"), fall back to dot-split only when the raw spec doesn't match.
function resolveTmuxWindowMatch(sessions: Session[], target: string): WindowMatch | null {
  const colonIdx = target.indexOf(':');
  if (colonIdx < 0) return null;
  const sessionName = target.slice(0, colonIdx);
  const rest = target.slice(colonIdx + 1);

  const rawWin = findWindow(sessions, sessionName, rest);
  if (rawWin) return { window: rawWin, matchedRaw: true };

  const dotIdx = rest.lastIndexOf('.');
  if (dotIdx < 0) return null;
  const strippedWin = findWindow(sessions, sessionName, rest.slice(0, dotIdx));
  return strippedWin ? { window: strippedWin, matchedRaw: false } : null;
}

// Shared by resolveActivePane (below) and any caller that only needs the live tmux window
// (e.g. its current pane count) rather than a specific pane — see TaskPanel's SP window bar
// ("▣ win ▾ Nペイン", Issue #69 T5).
export function resolveTmuxWindow(sessions: Session[], target: string): TmuxWindow | null {
  return resolveTmuxWindowMatch(sessions, target)?.window ?? null;
}

export function resolveActivePane(
  sessions: Session[],
  target: string,
): Pane | null {
  const match = resolveTmuxWindowMatch(sessions, target);
  if (!match) return null;
  const { window: win, matchedRaw } = match;

  const activePane = win.panes.find((p) => p.active);
  if (activePane) return activePane;

  // ".N" をペイン番号として再解釈するのは、raw ターゲット一致で解決できず stripped
  // フォールバックが効いた場合のみに限定する。raw 一致（例: ウィンドウ名が文字通り
  // "foo.1"）が成立しているのに ".1" をペインサフィックスとして再解釈すると、たまたま
  // pane index 1 が存在する場合に誤ったペインを選んでしまう。
  if (!matchedRaw) {
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
  }

  return win.panes[0] ?? null;
}
