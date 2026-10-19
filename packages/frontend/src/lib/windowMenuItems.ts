import { canActOnMux } from './windowRowPlan';

export type WindowMenuItemKind =
  | 'rename-label'
  | 'rename-window'
  | 'rename-pane'
  | 'capture-panes'
  | 'sleep'
  | 'respawn'
  | 'show-task'
  | 'detach'
  | 'delete-pane'
  | 'delete-window';

export interface WindowMenuItemDescriptor {
  kind: WindowMenuItemKind;
  /** i18n key (workspace namespace unless it names another with `ns:`). */
  labelKey: string;
  disabled?: boolean;
  danger?: boolean;
  /** delete-pane / rename-pane: the pane's 1-based ordinal in its window. */
  paneOrdinal?: number;
  /** delete-pane: the pane handle, so the server closes exactly that pane. */
  paneHandle?: string;
}

export interface WindowMenuParams {
  online: boolean;
  stale?: boolean;
  windowName?: string;
  paneTarget?: string;
  /** Set on an expanded pane row of a window with several panes. */
  paneOrdinal?: number;
  paneHandle?: string;
  /** misao cannot set a pane title. */
  canRenamePane: boolean;
  windowType?: string;
  agentSessionId?: string;
  sleeping?: boolean;
  hasLinkedTask: boolean;
}

export function buildWindowMenuItems(params: WindowMenuParams): WindowMenuItemDescriptor[] {
  const { online, paneOrdinal, paneHandle } = params;
  // A stale row's mux cannot be reached: the actions that go through it stay listed but disabled.
  const disabled = !canActOnMux(params);
  const items: WindowMenuItemDescriptor[] = [{ kind: 'rename-label', labelKey: 'windows.renameLabel' }];

  if (online && params.windowName !== undefined) {
    items.push({ kind: 'rename-window', labelKey: 'windows.renameWindow', disabled });
  }
  if (online && params.paneTarget && params.canRenamePane) {
    items.push({ kind: 'rename-pane', labelKey: 'windows.renamePane', disabled, paneOrdinal });
  }
  if (online) {
    items.push({ kind: 'capture-panes', labelKey: 'windows.capturePanes', disabled });
  }
  if (online && params.windowType === 'agent' && params.agentSessionId && !params.sleeping) {
    items.push({ kind: 'sleep', labelKey: 'windows.sleep', disabled });
  }
  if (!online) {
    items.push({ kind: 'respawn', labelKey: params.sleeping ? 'common:terminal.wake' : 'windows.respawn' });
  }
  if (params.hasLinkedTask) {
    items.push({ kind: 'show-task', labelKey: 'windows.showTask' });
  }
  items.push({ kind: 'detach', labelKey: 'windows.detachFromProject' });
  if (paneOrdinal !== undefined) {
    items.push(
      { kind: 'delete-pane', labelKey: 'windows.deletePane', danger: true, disabled, paneOrdinal, paneHandle },
      { kind: 'delete-window', labelKey: 'windows.deleteEntireWindow', danger: true, disabled },
    );
  } else {
    items.push({ kind: 'delete-window', labelKey: 'windows.deleteWindow', danger: true, disabled });
  }
  return items;
}
