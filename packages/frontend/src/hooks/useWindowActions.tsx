import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import type { ContextMenuItem } from '../components/ContextMenu';
import type { PersistedTab } from './useTabPersistence';
import type { Task } from '../pages/workspace/types';
import { useToast } from './useToast';
import { Icon } from '../components/ui/Icon';
import type { ResourceStatus } from '../components/ResourceWarningDialog';
import { isInsufficientResources } from './useAddWindowModal';

interface ConfirmDialog {
  title: string;
  message: string;
  onConfirm: () => void;
}

interface WindowActionDeps {
  showContextMenu: (e: React.MouseEvent, items: ContextMenuItem[]) => void;
  showContextMenuAt: (x: number, y: number, items: ContextMenuItem[]) => void;
  findTaskByTarget: (target: string) => Task | null;
  openTask: (taskId: number, title: string) => void;
  tabs: PersistedTab[];
  closeTab: (tabId: string) => void;
  refreshSessions?: () => Promise<void>;
  togglePin?: (tabId: string) => void;
  connectPane?: (serverName: string, target: string, projectId?: number, opts?: { reconnect?: boolean }) => void;
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

  const { showContextMenu, showContextMenuAt, findTaskByTarget, openTask, tabs, closeTab, refreshSessions, togglePin, connectPane } = deps;

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
          const base = tmuxTarget.replace(/\.\d+$/, '');
          let identity: { sessionName: string; windowIndex: number; windowName: string } | null = null;
          try {
            const res = await api<{ ok: boolean; identity?: { sessionName: string; windowIndex: number; windowName: string } | null }>(
              `/servers/${serverName}/windows/${encodeURIComponent(base)}`, { method: 'DELETE' },
            );
            identity = res.identity ?? null;
          } catch (e) {
            setConfirmDialog(null);
            showToast(t('windows.deleteFailed', { error: (e as Error).message }));
            return;
          }
          // Fallback cleanup: the tmux-kill route above already removes matching DB
          // rows, so this can 404 — best-effort only.
          await api(`/windows/${windowId}`, { method: 'DELETE' }).catch(() => {});
          // Tabs may address the window in name form ("sess:win--xxxx") or index form
          // ("sess:3") — match every form the killed window was known under.
          const bases = [base];
          if (identity) {
            bases.push(`${identity.sessionName}:${identity.windowName}`, `${identity.sessionName}:${identity.windowIndex}`);
          }
          const matchesDeletedTarget = (target: string) =>
            bases.some((b) => target === b || target.startsWith(`${b}.`));
          tabs
            .filter((tab) => tab.type === 'terminal' && tab.serverName === serverName && tab.target && matchesDeletedTarget(tab.target))
            .forEach((tab) => closeTab(tab.id));
          setConfirmDialog(null);
          refreshWorkspace();
        } finally {
          setWindowActionLoading(false);
        }
      },
    });
  }, [refreshWorkspace, showToast, tabs, closeTab]);

  const handleRenameLabel = useCallback(async (w: { id: number; label?: string }) => {
    const newLabel = prompt(t('windows.renameLabelPrompt'), w.label || '');
    if (newLabel === null) return;
    await api(`/windows/${w.id}`, { method: 'PUT', body: JSON.stringify({ label: newLabel }) });
    refreshWorkspace();
  }, [refreshWorkspace]);

  const handleRenameWindow = useCallback(async (serverName: string, tmuxTarget: string, currentName: string) => {
    const newName = prompt(t('windows.renameWindowPrompt'), currentName);
    if (!newName || newName === currentName) return;
    await api(`/servers/${serverName}/windows/${encodeURIComponent(tmuxTarget)}/rename`, { method: 'PUT', body: JSON.stringify({ name: newName }) });
    refreshWorkspace();
  }, [refreshWorkspace]);

  const handleRenamePane = useCallback(async (serverName: string, paneTarget: string, currentTitle: string) => {
    const newTitle = prompt(t('windows.renamePanePrompt'), currentTitle);
    if (!newTitle || newTitle === currentTitle) return;
    await api(`/servers/${serverName}/panes/${encodeURIComponent(paneTarget)}/rename`, { method: 'PUT', body: JSON.stringify({ title: newTitle }) });
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
        connectPane?.(serverName, result.tmuxTarget, undefined, { reconnect: true });
      }
    } finally {
      setRespawningWindowIds((prev) => {
        const next = new Set(prev);
        next.delete(windowId);
        return next;
      });
    }
  }, [refreshWorkspace, refreshSessions, connectPane, showToast]);

  const handleCapturePanes = useCallback(async (windowId: number) => {
    try {
      await api(`/windows/${windowId}/capture-panes`, { method: 'POST' });
      refreshWorkspace();
    } catch { /* best-effort */ }
  }, [refreshWorkspace]);

  const getWindowMenuItems = useCallback((w: { id: number; serverName: string; tmuxTarget: string; label?: string }, extra?: { online: boolean; windowName?: string; paneTarget?: string; paneTitle?: string }): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      { label: t('windows.renameLabel'), icon: <Icon name="edit" size={16} />, onClick: () => handleRenameLabel(w) },
    ];
    if (extra?.online && extra.windowName !== undefined) {
      items.push({ label: t('windows.renameWindow'), icon: <Icon name="edit" size={16} />, onClick: () => handleRenameWindow(w.serverName, w.tmuxTarget, extra.windowName!) });
    }
    if (extra?.online && extra.paneTarget) {
      items.push({ label: t('windows.renamePane'), icon: <Icon name="edit" size={16} />, onClick: () => handleRenamePane(w.serverName, extra.paneTarget!, extra.paneTitle || '') });
    }
    if (extra?.online) {
      items.push({ label: t('windows.capturePanes'), icon: <Icon name="camera" size={16} />, onClick: () => handleCapturePanes(w.id) });
    }
    if (!extra?.online) {
      items.push({ label: t('windows.respawn'), icon: <Icon name="refresh" size={16} />, onClick: () => handleRespawnWindow(w.id, w.serverName) });
    }
    const linkedTask = findTaskByTarget(w.tmuxTarget);
    if (linkedTask) {
      items.push({ label: t('windows.showTask'), icon: <Icon name="tasks" size={16} />, onClick: () => openTask(linkedTask.id, linkedTask.title) });
    }
    items.push(
      { label: t('windows.detachFromProject'), icon: <Icon name="external-link" size={16} />, onClick: () => handleDetachWindow(w.id) },
      { label: t('windows.deleteWindow'), icon: <Icon name="trash" size={16} />, danger: true, onClick: () => handleDeleteWindow(w.serverName, w.tmuxTarget, w.id) },
    );
    return items;
  }, [handleRenameLabel, handleRenameWindow, handleRenamePane, handleDetachWindow, handleDeleteWindow, handleRespawnWindow, handleCapturePanes, findTaskByTarget, openTask]);

  const showWindowContextMenu = useCallback((e: React.MouseEvent, w: { id: number; serverName: string; tmuxTarget: string; label?: string }, extra?: { online: boolean; windowName?: string; paneTarget?: string; paneTitle?: string }) => {
    showContextMenu(e, getWindowMenuItems(w, extra));
  }, [showContextMenu, getWindowMenuItems]);

  const showWindowContextMenuAt = useCallback((x: number, y: number, w: { id: number; serverName: string; tmuxTarget: string; label?: string }, extra?: { online: boolean; windowName?: string; paneTarget?: string; paneTitle?: string }) => {
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
    handleRenameLabel,
    handleRenameWindow,
    handleRenamePane,
    handleRespawnWindow,
    handleCapturePanes,
    getWindowMenuItems,
    showWindowContextMenu,
    showWindowContextMenuAt,
    getTabMenuItems,
    handleTabContextMenu,
    handleTabLongPress,
  };
}
