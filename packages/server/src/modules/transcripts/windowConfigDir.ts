import type { Window } from '../windows/Window';

export function configDirForSession(window: Window, sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  const live = window.claudePaneSessions?.find((item) => item.sessionId === sessionId);
  if (live) return live.configDir;
  const pane = window.paneLayout?.panes.find((item) => item.agentSessionId === sessionId);
  if (pane) return pane.claudeConfigDir ?? null;
  return window.agentSessionId === sessionId ? window.claudeConfigDir ?? null : null;
}
