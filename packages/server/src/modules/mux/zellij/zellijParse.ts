export interface ZellijPaneInfo {
  id: number;
  isPlugin: boolean;
  isFocused: boolean;
  isFullscreen: boolean;
  isFloating: boolean;
  isSuppressed: boolean;
  title: string;
  exited: boolean;
  tabId: number;
  tabPosition: number;
  tabName: string;
  paneCommand: string | null;
  paneCwd: string | null;
  paneRows: number;
  paneColumns: number;
}

export function parseListSessions(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes('[EXITED]'))
    .map((line) => {
      const bracketIdx = line.indexOf(' [');
      return bracketIdx === -1 ? line : line.slice(0, bracketIdx);
    });
}

/** Returns tab names in tab_position order (0-based index = position). */
export function parseQueryTabNames(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

interface RawListPanesEntry {
  id: number;
  is_plugin: boolean;
  is_focused: boolean;
  is_fullscreen: boolean;
  is_floating: boolean;
  is_suppressed: boolean;
  title: string;
  exited: boolean;
  tab_id: number;
  tab_position: number;
  tab_name: string;
  pane_command?: string | null;
  pane_cwd?: string | null;
  pane_rows: number;
  pane_columns: number;
}

export function parseListPanes(stdout: string): ZellijPaneInfo[] {
  const raw = JSON.parse(stdout) as RawListPanesEntry[];
  return raw.map((p) => ({
    id: p.id,
    isPlugin: p.is_plugin,
    isFocused: p.is_focused,
    isFullscreen: p.is_fullscreen,
    isFloating: p.is_floating,
    isSuppressed: p.is_suppressed,
    title: p.title,
    exited: p.exited,
    tabId: p.tab_id,
    tabPosition: p.tab_position,
    tabName: p.tab_name,
    paneCommand: p.pane_command ?? null,
    paneCwd: p.pane_cwd ?? null,
    paneRows: p.pane_rows,
    paneColumns: p.pane_columns,
  }));
}

export function formatZellijPaneId(id: number, isPlugin: boolean): string {
  return isPlugin ? `plugin_${id}` : `terminal_${id}`;
}

export function parseZellijPaneId(paneId: string): { id: number; isPlugin: boolean } {
  const pluginMatch = /^plugin_(\d+)$/.exec(paneId);
  if (pluginMatch) return { id: Number(pluginMatch[1]), isPlugin: true };
  const termMatch = /^terminal_(\d+)$/.exec(paneId);
  if (termMatch) return { id: Number(termMatch[1]), isPlugin: false };
  const numMatch = /^(\d+)$/.exec(paneId);
  if (numMatch) return { id: Number(numMatch[1]), isPlugin: false };
  throw new Error(`Invalid zellij pane ID: ${paneId}`);
}
