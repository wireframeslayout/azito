import type { MethodResult } from '@misao/protocol' with { 'resolution-mode': 'import' };
import type { MuxPane, MuxPaneInfo, MuxRef, MuxWindowInfo, MuxWorkspace } from '@azito/shared';

export type MisaoPane = MethodResult<'pane.list'>[number];
export type MisaoWorkspace = MethodResult<'workspace.list'>[number];

export function misaoRef(workspace: string, windowId: string): MuxRef {
  return { kind: 'misao', workspace, window: windowId };
}

/** Pane ids are ULIDs, so id order is creation order; sorting makes the in-window order independent of the daemon's list order. */
export function sortPanes(panes: readonly MisaoPane[]): MisaoPane[] {
  return [...panes].sort((a, b) => (a.paneId < b.paneId ? -1 : a.paneId > b.paneId ? 1 : 0));
}

export function panesOfWindow(panes: readonly MisaoPane[], windowId: string): MisaoPane[] {
  return sortPanes(panes).filter((p) => p.window.id === windowId);
}

/** Foreground command when the daemon reports one (running panes), otherwise the launch command. */
export function paneCommand(pane: MisaoPane): string {
  return pane.fgCommand ?? pane.cmd[0];
}

/** Latest output time among the panes in epoch seconds (tmux's window_activity unit), or null when none has produced output. */
export function lastOutputEpochSeconds(panes: readonly MisaoPane[]): number | null {
  const times = panes.flatMap((p) => (p.lastOutputAt === null ? [] : [Date.parse(p.lastOutputAt)]));
  return times.length === 0 ? null : Math.floor(Math.max(...times) / 1000);
}

/** Window and pane indexes are 1-based: AZITO's pane ordinals and window numbers follow tmux base-index / pane-base-index 1, and the UI uses `index` as the ordinal as-is. */
function toMuxPane(pane: MisaoPane, index: number): MuxPane {
  return { index, handle: pane.paneId, command: paneCommand(pane), title: pane.title, width: pane.cols, height: pane.rows, active: false, pid: pane.pid ?? 0, processState: pane.processState };
}

function toMuxWindow(workspace: string, window: MisaoWorkspace['windows'][number], index: number, panes: readonly MisaoPane[]): MuxWindowInfo {
  const windowPanes = panesOfWindow(panes, window.windowId);
  return {
    index,
    name: window.name,
    active: false,
    panes: windowPanes.map((p, i) => toMuxPane(p, i + 1)),
    activity: lastOutputEpochSeconds(windowPanes) ?? 0,
    ref: misaoRef(workspace, window.windowId),
  };
}

export function toMuxWorkspaces(workspaces: readonly MisaoWorkspace[], panes: readonly MisaoPane[]): MuxWorkspace[] {
  return workspaces.map((ws) => ({
    name: ws.name,
    windowCount: ws.windows.length,
    attached: false,
    created: 0,
    windows: ws.windows.map((w, i) => toMuxWindow(ws.name, w, i + 1, panes)),
  }));
}

/** Panes whose window is not in `workspaces` were closed between the two reads and are dropped. */
export function toMuxPaneInfos(workspaces: readonly MisaoWorkspace[], panes: readonly MisaoPane[]): MuxPaneInfo[] {
  const windowIndex = new Map<string, number>();
  for (const ws of workspaces) ws.windows.forEach((w, i) => windowIndex.set(w.windowId, i + 1));
  const paneIndexInWindow = new Map<string, number>();
  const infos: MuxPaneInfo[] = [];
  for (const pane of sortPanes(panes)) {
    const index = windowIndex.get(pane.window.id);
    if (index === undefined) continue;
    const paneIndex = paneIndexInWindow.get(pane.window.id) ?? 1;
    paneIndexInWindow.set(pane.window.id, paneIndex + 1);
    infos.push({
      paneId: pane.paneId,
      sessionName: pane.workspace,
      windowIndex: index,
      windowName: pane.window.name,
      paneIndex,
      currentPath: pane.cwd,
      currentCommand: paneCommand(pane),
      ref: misaoRef(pane.workspace, pane.window.id),
    });
  }
  return infos;
}
