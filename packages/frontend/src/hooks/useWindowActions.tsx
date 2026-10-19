import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { formatWindowId, type MuxRef } from '@azito/shared';
import { api } from '../api/client';
import type { ContextMenuItem } from '../components/ContextMenu';
import type { PersistedTab } from './useTabPersistence';
import type { Task } from '../pages/workspace/types';
import type { Server } from './useServerManagement';
import { useToast } from './useToast';
import { Icon } from '../components/ui/Icon';
import type { ResourceStatus } from '../components/ResourceWarningDialog';
import { isInsufficientResources } from './useAddWindowModal';
import { canRenamePane } from '../lib/windowRowPlan';
import { buildWindowMenuItems, type WindowMenuItemDescriptor, type WindowMenuParams } from '../lib/windowMenuItems';
import { paneDeletePath, refTabMatchesTarget } from '../lib/terminalRef';

interface ConfirmDialog {
  title: string;
  message: string;
  onConfirm: () => void;
}

type WindowMenuExtra = Pick<WindowMenuParams, 'online' | 'stale' | 'windowName' | 'paneOrdinal' | 'paneHandle'> & { paneTarget?: string; paneTitle?: string };

interface WindowActionDeps {
  showContextMenu: (e: React.MouseEvent, items: ContextMenuItem[]) => void;
  showContextMenuAt: (x: number, y: number, items: ContextMenuItem[]) => void;
  findTaskByTarget: (target: string) => Task | null;
  openTask: (taskId: number, title: string) => void;
  tabs: PersistedTab[];
  closeTab: (tabId: string) => void;
  refreshSessions?: () => Promise<void>;
  togglePin?: (tabId: string) => void;
  /** Shows a respawned window again, forcing its terminal to reconnect. */
  reconnectWindow?: (win: { serverName: string; windowId: number; tmuxTarget: string }) => void | Promise<void>;
  servers?: Server[];
}

export function useWindowActions(
  projectId: string | undefined,
  refreshWorkspace: () => void,
  deps: WindowActionDeps,
) {
  const { t } = useTranslation('workspace');
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialog | null>(null);
  const [windowActionLoading, setWindowActionLoading] = useState(false);
  const [respawningWindowIds, setRespawningWindowIds] = useState<Set<number>>(new Set());
  const [respawnResourceWarning, setRespawnResourceWarning] = useState<{ resources: ResourceStatus; retry: () => void } | null>(null);
  const { showToast } = useToast();

  const { showContextMenu, showContextMenuAt, findTaskByTarget, openTask, tabs, closeTab, refreshSessions, togglePin, reconnectWindow, servers } = deps;

  const handleDetachWindow = useCallback(async (windowId: number) => {
    setConfirmDialog({
      title: t('windows.detachTitle'),
      message: t('windows.detachMessage'),
      onConfirm: async () => {
        setWindowActionLoading(true);
        try {
          await api(`/windows/${windowId}`, { method: 'DELETE' });
          setConfirmDialog(null);
          refreshWorkspace();
        } finally {
          setWindowActionLoading(false);
        }
      },
    });
  }, [refreshWorkspace]);

  // Closes every terminal tab that addressed the deleted window: by windowId, by ref, or by a target in
  // name form ("sess:win--xxxx") / index form ("sess:3") — every form the window was known under.
  const closeDeletedWindowTabs = useCallback((
    serverName: string,
    tmuxTarget: string,
    windowId: number,
    identity: { sessionName: string; windowIndex: number; windowName: string } | null,
  ) => {
    const bases = [tmuxTarget.replace(/\.\d+$/, '')];
    if (identity) {
      bases.push(`${identity.sessionName}:${identity.windowName}`, `${identity.sessionName}:${identity.windowIndex}`);
    }
    const matchesDeletedTarget = (target: string) =>
      bases.some((b) => target === b || target.startsWith(`${b}.`));
    tabs
      .filter((tab) => tab.type === 'terminal' && tab.serverName === serverName && (
        (tab.target && matchesDeletedTarget(tab.target)) ||
        (tab.terminalRef?.kind === 'windowId' && tab.terminalRef.windowId === windowId) ||
        (tab.terminalRef?.kind === 'ref' && refTabMatchesTarget(tab.terminalRef.ref, tmuxTarget))
      ))
      .forEach((tab) => closeTab(tab.id));
  }, [tabs, closeTab]);

  const handleDeleteWindow = useCallback(async (serverName: string, tmuxTarget: string, windowId: number) => {
    setConfirmDialog({
      title: t('windows.deleteTitle'),
      message: t('windows.deleteMessage'),
      onConfirm: async () => {
        setWindowActionLoading(true);
        try {
          // Kill the whole tmux window (not just pane .1 — a multi-pane window would
          // otherwise survive, and pane-index bases vary across servers). The server
          // route also removes matching DB rows; the /windows/:id call below is the
          // fallback cleanup when the tmux window is already gone.
          let identity: { sessionName: string; windowIndex: number; windowName: string } | null = null;
          try {
            // Use windowId kill route (5-A) which also removes the tmux window and DB rows.
            const res = await api<{ ok: boolean; identity?: { sessionName: string; windowIndex: number; windowName: string } | null }>(
              `/windows/${windowId}/kill`, { method: 'DELETE' },
            );
            identity = res.identity ?? null;
          } catch (e) {
            setConfirmDialog(null);
            showToast(t('windows.deleteFailed', { error: (e as Error).message }));
            return;
          }
          closeDeletedWindowTabs(serverName, tmuxTarget, windowId, identity);
          setConfirmDialog(null);
          refreshWorkspace();
        } finally {
          setWindowActionLoading(false);
        }
      },
    });
  }, [refreshWorkspace, showToast, closeDeletedWindowTabs]);

  // After an empty window's [open pane] / [delete window] inline actions: the DB rows (and tabs) of a deleted
  // window must go together with its session entry, or it lingers as an offline row.
  const handleEmptyWindowChanged = useCallback((outcome: 'pane_opened' | 'window_deleted', w: { serverName: string; tmuxTarget: string; id: number }) => {
    if (outcome === 'window_deleted') closeDeletedWindowTabs(w.serverName, w.tmuxTarget, w.id, null);
    refreshWorkspace();
    void refreshSessions?.();
  }, [closeDeletedWindowTabs, refreshWorkspace, refreshSessions]);

  const handleRenameLabel = useCallback(async (w: { id: number; label?: string }) => {
    const newLabel = prompt(t('windows.renameLabelPrompt'), w.label || '');
    if (newLabel === null) return;
    await api(`/windows/${w.id}`, { method: 'PUT', body: JSON.stringify({ label: newLabel }) });
    refreshWorkspace();
  }, [refreshWorkspace]);

  const handleRenameWindow = useCallback(async (serverName: string, tmuxTarget: string, currentName: string, windowId?: number, ref?: string) => {
    const newName = prompt(t('windows.renameWindowPrompt'), currentName);
    if (!newName || newName === currentName) return;
    if (windowId != null) {
      await api(`/windows/${windowId}/rename`, { method: 'PUT', body: JSON.stringify({ name: newName }) });
    } else if (ref) {
      await api(`/servers/${encodeURIComponent(serverName)}/mux/windows/${encodeURIComponent(ref)}/rename`, { method: 'PUT', body: JSON.stringify({ name: newName }) });
    } else {
      await api(`/servers/${serverName}/windows/${encodeURIComponent(tmuxTarget)}/rename`, { method: 'PUT', body: JSON.stringify({ name: newName }) });
    }
    refreshWorkspace();
  }, [refreshWorkspace]);

  const handleRenamePane = useCallback(async (serverName: string, paneTarget: string, currentTitle: string, windowId?: number, paneOrdinal?: number, ref?: string) => {
    const newTitle = prompt(t('windows.renamePanePrompt'), currentTitle);
    if (!newTitle || newTitle === currentTitle) return;
    if (windowId != null && paneOrdinal != null) {
      await api(`/windows/${windowId}/panes/${paneOrdinal}/rename`, { method: 'PUT', body: JSON.stringify({ title: newTitle }) });
    } else if (ref && paneOrdinal != null) {
      await api(`/servers/${encodeURIComponent(serverName)}/mux/windows/${encodeURIComponent(ref)}/panes/${paneOrdinal}/rename`, { method: 'PUT', body: JSON.stringify({ name: newTitle }) });
    } else {
      await api(`/servers/${serverName}/panes/${encodeURIComponent(paneTarget)}/rename`, { method: 'PUT', body: JSON.stringify({ title: newTitle }) });
    }
    refreshWorkspace();
  }, [refreshWorkspace]);

  const handleRespawnWindow = useCallback(async function perform(windowId: number, serverName?: string, force = false) {
    setRespawningWindowIds((prev) => new Set(prev).add(windowId));
    try {
      const result = await api<{ ok: boolean; tmuxTarget: string; error?: string }>(`/windows/${windowId}/respawn`, {
        method: 'POST',
        body: JSON.stringify({ force }),
      });
      if (isInsufficientResources(result)) {
        setRespawnResourceWarning({
          resources: result.resources,
          retry: () => {
            setRespawnResourceWarning(null);
            void perform(windowId, serverName, true);
          },
        });
        return;
      }
      if (!result.tmuxTarget) {
        showToast(result.error || t('windows.respawnFailed'));
        return;
      }
      refreshWorkspace();
      await refreshSessions?.();
      if (serverName) {
        await reconnectWindow?.({ serverName, windowId, tmuxTarget: result.tmuxTarget });
      }
    } finally {
      setRespawningWindowIds((prev) => {
        const next = new Set(prev);
        next.delete(windowId);
        return next;
      });
    }
  }, [refreshWorkspace, refreshSessions, reconnectWindow, showToast]);

  const handleSleepWindow = useCallback(async (windowId: number) => {
    try {
      await api(`/windows/${windowId}/sleep`, { method: 'POST' });
      refreshWorkspace();
    } catch (e) {
      showToast(t('windows.sleepFailed') + ': ' + (e as Error).message);
    }
  }, [refreshWorkspace, showToast]);

  const handleCapturePanes = useCallback(async (windowId: number) => {
    try {
      await api(`/windows/${windowId}/capture-panes`, { method: 'POST' });
      refreshWorkspace();
    } catch { /* best-effort */ }
  }, [refreshWorkspace]);

  const handleDeletePane = useCallback((serverName: string, windowId: number, ordinal: number, handle: string | undefined, label: string) => {
    setConfirmDialog({
      title: t('servers:confirm.killPane'),
      message: t('servers:confirm.killPaneMessage', { name: label }),
      onConfirm: async () => {
        setWindowActionLoading(true);
        try {
          await api(paneDeletePath({ kind: 'windowId', serverName, windowId, pane: ordinal }, handle), { method: 'DELETE' });
          setConfirmDialog(null);
          refreshWorkspace();
          void refreshSessions?.();
        } catch (e) {
          setConfirmDialog(null);
          showToast(t('windows.deleteFailed', { error: (e as Error).message }));
        } finally {
          setWindowActionLoading(false);
        }
      },
    });
  }, [refreshWorkspace, refreshSessions, showToast]);

  const getWindowMenuItems = useCallback((w: { id: number; serverName: string; tmuxTarget: string; label?: string; windowType?: string; agentSessionId?: string; sleeping?: boolean; muxRef?: MuxRef }, extra?: WindowMenuExtra): ContextMenuItem[] => {
    const linkedTask = findTaskByTarget(w.tmuxTarget);
    const descriptors = buildWindowMenuItems({
      online: extra?.online ?? false,
      stale: extra?.stale,
      windowName: extra?.windowName,
      paneTarget: extra?.paneTarget,
      paneOrdinal: extra?.paneOrdinal,
      paneHandle: extra?.paneHandle,
      canRenamePane: canRenamePane(w),
      windowType: w.windowType,
      agentSessionId: w.agentSessionId,
      sleeping: w.sleeping,
      hasLinkedTask: linkedTask !== null,
    });
    const actions: Record<WindowMenuItemDescriptor['kind'], { icon: React.ReactNode; run: (d: WindowMenuItemDescriptor) => void }> = {
      'rename-label': { icon: <Icon name="edit" size={16} />, run: () => void handleRenameLabel(w) },
      'rename-window': { icon: <Icon name="edit" size={16} />, run: () => void handleRenameWindow(w.serverName, w.tmuxTarget, extra!.windowName!, w.id) },
      'rename-pane': { icon: <Icon name="edit" size={16} />, run: (d) => void handleRenamePane(w.serverName, extra!.paneTarget!, extra!.paneTitle || '', w.id, d.paneOrdinal) },
      'capture-panes': { icon: <Icon name="camera" size={16} />, run: () => void handleCapturePanes(w.id) },
      sleep: { icon: <Icon name="moon" size={16} />, run: () => void handleSleepWindow(w.id) },
      respawn: { icon: <Icon name="refresh" size={16} />, run: () => void handleRespawnWindow(w.id, w.serverName) },
      'show-task': { icon: <Icon name="tasks" size={16} />, run: () => openTask(linkedTask!.id, linkedTask!.title) },
      detach: { icon: <Icon name="external-link" size={16} />, run: () => void handleDetachWindow(w.id) },
      'delete-pane': { icon: <Icon name="trash" size={16} />, run: (d) => handleDeletePane(w.serverName, w.id, d.paneOrdinal!, d.paneHandle, extra!.paneTitle || extra!.paneTarget!) },
      'delete-window': { icon: <Icon name="trash" size={16} />, run: () => void handleDeleteWindow(w.serverName, w.tmuxTarget, w.id) },
    };
    const items: ContextMenuItem[] = descriptors.map((d) => ({
      label: t(d.labelKey),
      icon: actions[d.kind].icon,
      danger: d.danger,
      disabled: d.disabled,
      onClick: () => actions[d.kind].run(d),
    }));
    items.push(
      { label: '', separator: true, onClick: () => {} },
      { label: `${formatWindowId(w.id)} · tmux ${w.tmuxTarget}`, disabled: true, onClick: () => {} },
    );
    return items;
  }, [handleRenameLabel, handleRenameWindow, handleRenamePane, handleDetachWindow, handleDeleteWindow, handleDeletePane, handleRespawnWindow, handleSleepWindow, handleCapturePanes, findTaskByTarget, openTask]);

  const showWindowContextMenu = useCallback((e: React.MouseEvent, w: { id: number; serverName: string; tmuxTarget: string; label?: string }, extra?: WindowMenuExtra) => {
    showContextMenu(e, getWindowMenuItems(w, extra));
  }, [showContextMenu, getWindowMenuItems]);

  const showWindowContextMenuAt = useCallback((x: number, y: number, w: { id: number; serverName: string; tmuxTarget: string; label?: string }, extra?: WindowMenuExtra) => {
    showContextMenuAt(x, y, getWindowMenuItems(w, extra));
  }, [showContextMenuAt, getWindowMenuItems]);

  const getTabMenuItems = useCallback((tabId: string): ContextMenuItem[] => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return [];
    const items: ContextMenuItem[] = [];
    if (tab.type === 'terminal' && tab.target) {
      const linkedTask = findTaskByTarget(tab.target);
      if (linkedTask) {
        items.push({ label: t('windows.showTask'), icon: <Icon name="tasks" size={16} />, onClick: () => openTask(linkedTask.id, linkedTask.title) });
      }
    }
    if (togglePin) {
      items.push({
        label: tab.pinned ? t('windows.unpinTab') : t('windows.pinTab'),
        icon: <Icon name="pin" size={16} />,
        onClick: () => togglePin(tabId),
      });
    }
    items.push({ label: t('windows.closeTab'), icon: '✕', onClick: () => closeTab(tabId) });
    return items;
  }, [tabs, closeTab, findTaskByTarget, openTask, togglePin]);

  const handleTabContextMenu = useCallback((e: React.MouseEvent, tabId: string) => {
    const items = getTabMenuItems(tabId);
    if (items.length > 0) showContextMenu(e, items);
  }, [getTabMenuItems, showContextMenu]);

  const handleTabLongPress = useCallback((x: number, y: number, tabId: string) => {
    const items = getTabMenuItems(tabId);
    if (items.length > 0) showContextMenuAt(x, y, items);
  }, [getTabMenuItems, showContextMenuAt]);

  return {
    confirmDialog,
    setConfirmDialog,
    windowActionLoading,
    respawningWindowIds,
    respawnResourceWarning,
    setRespawnResourceWarning,
    handleDetachWindow,
    handleDeleteWindow,
    handleEmptyWindowChanged,
    handleRenameLabel,
    handleRenameWindow,
    handleRenamePane,
    handleRespawnWindow,
    handleSleepWindow,
    handleCapturePanes,
    getWindowMenuItems,
    showWindowContextMenu,
    showWindowContextMenuAt,
    getTabMenuItems,
    handleTabContextMenu,
    handleTabLongPress,
  };
}
