import { describeWakeError } from '../lib/muxSwitchError';
import { useAgentActivity } from './useAgentActivity';
import { useWakeWindow } from './useWakeWindow';
import { useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { formatWindowTitleLine, resolveWindowTitle, type MuxDriverKind, type MuxRef } from '@azito/shared';
import { api } from '../api/client';
import { useOrchestratorRole } from './useOrchestratorRole';
import type { ContextMenuItem } from '../components/ContextMenu';
import type { PersistedTab } from './useTabPersistence';
import type { Task } from '../pages/workspace/types';
import type { Server } from './useServerManagement';
import { useToast } from './useToast';
import { Icon } from '../components/ui/Icon';
import type { ResourceStatus } from '../components/ResourceWarningDialog';
import { isInsufficientResources } from './useAddWindowModal';
import { windowMuxKind, windowTitleInput } from '../lib/windowDisplay';
import { canRenamePane } from '../lib/windowRowPlan';
import { buildWindowMenuItems, windowMenuInfo, type WindowMenuItemDescriptor, type WindowMenuParams } from '../lib/windowMenuItems';
import { paneDeletePath, refTabMatchesTarget, tabsToCloseAfterPaneDelete } from '../lib/terminalRef';

interface ConfirmDialog {
  title: string;
  message: string;
  onConfirm: () => void;
  confirmLabel?: string;
  confirmVariant?: 'primary' | 'danger';
}

type WindowMenuExtra = Pick<WindowMenuParams, 'online' | 'stale' | 'windowName' | 'paneOrdinal' | 'paneHandle'> & { paneTarget?: string; paneTitle?: string };

interface WindowActionDeps {
  maximizeWindow?: (windowId: number) => void;
  resolveTabWindow?: (tab: PersistedTab) => number | null;
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
  const changeRole = useOrchestratorRole(refreshWorkspace);
  const wake = useWakeWindow();
  const { activityStatus } = useAgentActivity();
  const [misaoServers, setMisaoServers] = useState<Set<string> | null>(null);
  useEffect(() => {
    let active = true;
    api<Array<{ name: string }>>('/settings/mux-switch/servers').then((result) => {
      if (active && Array.isArray(result)) setMisaoServers(new Set(result.map((server) => server.name)));
    }).catch(() => { if (active) setMisaoServers(null); });
    return () => { active = false; };
  }, [deps.servers]);
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
      await api(`/windows/${windowId}/panes/${paneOrdinal}/rename`, { method: 'PUT', body: JSON.stringify({ name: newTitle }) });
    } else if (ref && paneOrdinal != null) {
      await api(`/servers/${encodeURIComponent(serverName)}/mux/windows/${encodeURIComponent(ref)}/panes/${paneOrdinal}/rename`, { method: 'PUT', body: JSON.stringify({ name: newTitle }) });
    } else {
      await api(`/servers/${serverName}/panes/${encodeURIComponent(paneTarget)}/rename`, { method: 'PUT', body: JSON.stringify({ title: newTitle }) });
    }
    refreshWorkspace();
  }, [refreshWorkspace]);

  const handleRespawnWindow = useCallback(async function perform(windowId: number, serverName?: string, force = false, chosenMux?: MuxDriverKind, offerTmuxRetry = false, title?: string, reconnect = true) {
    setRespawningWindowIds((prev) => new Set(prev).add(windowId));
    let mux: MuxDriverKind | null | undefined = chosenMux;
    // Waking a sleeping tmux window into misao can be retried in tmux; an awake window is never offered that (it would be killed).
    const reportFailure = (message: string): void => {
      if (mux === 'misao' && offerTmuxRetry) {
        setConfirmDialog({ title: t('common:terminal.muxErrorTitle'), message, confirmLabel: t('common:terminal.muxRetryTmux'), confirmVariant: 'primary', onConfirm: () => { setConfirmDialog(null); void perform(windowId, serverName, false, 'tmux'); } });
      } else showToast(message);
    };
    try {
      mux = mux ?? await wake.choose(windowId, title ?? formatWindowTitleLine(resolveWindowTitle({ id: windowId })));
      if (!mux) return;
      const result = await api<{ ok: boolean; tmuxTarget: string; error?: string; reason?: string }>(`/windows/${windowId}/respawn`, {
        method: 'POST',
        body: JSON.stringify({ force, mux }),
      });
      if (isInsufficientResources(result)) {
        setRespawnResourceWarning({
          resources: result.resources,
          retry: () => {
            setRespawnResourceWarning(null);
            void perform(windowId, serverName, true, mux ?? undefined, offerTmuxRetry);
          },
        });
        return;
      }
      if (!result.tmuxTarget) {
        reportFailure(describeWakeError(result, (key) => t(`common:${key}`)));
        return;
      }
      refreshWorkspace();
      await refreshSessions?.();
      if (serverName && reconnect) {
        await reconnectWindow?.({ serverName, windowId, tmuxTarget: result.tmuxTarget });
      }
    } catch (err) {
      reportFailure(err instanceof Error ? err.message : t('windows.respawnFailed'));
    } finally {
      setRespawningWindowIds((prev) => {
        const next = new Set(prev);
        next.delete(windowId);
        return next;
      });
    }
  }, [refreshWorkspace, refreshSessions, reconnectWindow, showToast, wake.choose, t]);

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

  const handleDeletePane = useCallback((serverName: string, windowId: number, ordinal: number, handle: string | undefined, label: string, windowKind: MuxDriverKind | undefined) => {
    setConfirmDialog({
      title: t('servers:confirm.killPane'),
      message: t('servers:confirm.killPaneMessage', { name: label }),
      onConfirm: async () => {
        setWindowActionLoading(true);
        try {
          await api(paneDeletePath({ kind: 'windowId', serverName, windowId, pane: ordinal }, handle), { method: 'DELETE' });
          tabsToCloseAfterPaneDelete(tabs, { serverName, windowId, ordinal, windowKind }).forEach((tab) => closeTab(tab.id));
          setConfirmDialog(null);
          refreshWorkspace();
          void refreshSessions?.();
        } catch (e) {
          setConfirmDialog(null);
          showToast(t('windows.deletePaneFailed', { error: (e as Error).message }));
        } finally {
          setWindowActionLoading(false);
        }
      },
    });
  }, [tabs, closeTab, refreshWorkspace, refreshSessions, showToast]);

  const getWindowMenuItems = useCallback((w: { id: number; serverName: string; tmuxTarget: string; ownerType?: 'project' | 'task' | 'server'; role?: 'orchestrator' | null; label?: string; labelSource?: 'auto' | 'user'; workerType?: string; windowType?: string; agentSessionId?: string; sleeping?: boolean; muxRef?: MuxRef }, extra?: WindowMenuExtra): ContextMenuItem[] => {
    const linkedTask = findTaskByTarget(w.tmuxTarget);
    const descriptors = buildWindowMenuItems({
      online: extra?.online ?? false,
      stale: extra?.stale,
      windowName: extra?.windowName,
      paneTarget: extra?.paneTarget,
      paneOrdinal: extra?.paneOrdinal,
      paneHandle: extra?.paneHandle,
      canRenamePane: canRenamePane(w),
      muxKind: windowMuxKind(w),
      windowType: w.windowType,
      agentSessionId: w.agentSessionId,
      sleeping: w.sleeping,
      busy: activityStatus(w.serverName, w.tmuxTarget) !== null,
      misaoSupported: misaoServers?.has(w.serverName) ?? false,
      hasLinkedTask: linkedTask !== null,
    });
    const actions: Record<WindowMenuItemDescriptor['kind'], { icon: React.ReactNode; run: (d: WindowMenuItemDescriptor) => void }> = {
      'rename-label': { icon: <Icon name="edit" size={16} />, run: () => void handleRenameLabel(w) },
      'rename-window': { icon: <Icon name="edit" size={16} />, run: () => void handleRenameWindow(w.serverName, w.tmuxTarget, extra!.windowName!, w.id) },
      'rename-pane': { icon: <Icon name="edit" size={16} />, run: (d) => void handleRenamePane(w.serverName, extra!.paneTarget!, extra!.paneTitle || '', w.id, d.paneOrdinal) },
      'capture-panes': { icon: <Icon name="camera" size={16} />, run: () => void handleCapturePanes(w.id) },
      sleep: { icon: <Icon name="moon" size={16} />, run: () => void handleSleepWindow(w.id) },
      'switch-misao': { icon: <Icon name="terminal" size={16} />, run: () => { void (async () => { try { const mux = await wake.choose(w.id, formatWindowTitleLine(resolveWindowTitle({ ...windowTitleInput(w), tmuxTarget: w.tmuxTarget })), true); if (mux) await handleRespawnWindow(w.id, w.serverName, false, mux, false); } catch (err) { showToast(err instanceof Error ? err.message : t('windows.respawnFailed')); } })(); } },
      respawn: { icon: <Icon name="refresh" size={16} />, run: () => void handleRespawnWindow(w.id, w.serverName, false, undefined, windowMuxKind(w) === 'tmux', formatWindowTitleLine(resolveWindowTitle(windowTitleInput(w)))) },
      'show-task': { icon: <Icon name="tasks" size={16} />, run: () => openTask(linkedTask!.id, linkedTask!.title) },
      detach: { icon: <Icon name="external-link" size={16} />, run: () => void handleDetachWindow(w.id) },
      'delete-pane': { icon: <Icon name="trash" size={16} />, run: (d) => handleDeletePane(w.serverName, w.id, d.paneOrdinal!, d.paneHandle, extra!.paneTitle || extra!.paneTarget!, w.muxRef?.kind) },
      'delete-window': { icon: <Icon name="trash" size={16} />, run: () => void handleDeleteWindow(w.serverName, w.tmuxTarget, w.id) },
    };
    const items: ContextMenuItem[] = descriptors.map((d) => ({
      kind: d.kind,
      label: t(d.labelKey),
      icon: actions[d.kind].icon,
      danger: d.danger,
      disabled: d.disabled,
      description: d.disabledReasonKey ? t(d.disabledReasonKey) : undefined,
      onClick: () => actions[d.kind].run(d),
    }));
    if (deps.maximizeWindow) items.unshift({ kind: 'maximize', label: t('maximize.action'), onClick: () => deps.maximizeWindow?.(w.id) });
    if (w.windowType === 'agent' && w.ownerType !== 'task' && w.ownerType !== undefined) {
      const role = w.role === 'orchestrator' ? null : 'orchestrator';
      items.push({ kind: 'change-role', label: t(role ? 'orchestration.makeOrchestrator' : 'orchestration.removeRole'), onClick: () => { void changeRole(w.id, role); } });
    }
    items.push(
      { label: '', separator: true, onClick: () => {} },
      { label: windowMenuInfo(w), disabled: true, onClick: () => {} },
    );
    return items;
  }, [handleRenameLabel, handleRenameWindow, handleRenamePane, handleDetachWindow, handleDeleteWindow, handleDeletePane, handleRespawnWindow, handleSleepWindow, handleCapturePanes, findTaskByTarget, openTask, activityStatus, wake.choose, showToast, t, misaoServers, deps.maximizeWindow, changeRole]);

  const showWindowContextMenu = useCallback((e: React.MouseEvent, w: { id: number; serverName: string; tmuxTarget: string; label?: string; muxRef?: MuxRef }, extra?: WindowMenuExtra) => {
    showContextMenu(e, getWindowMenuItems(w, extra));
  }, [showContextMenu, getWindowMenuItems]);

  const showWindowContextMenuAt = useCallback((x: number, y: number, w: { id: number; serverName: string; tmuxTarget: string; label?: string; muxRef?: MuxRef }, extra?: WindowMenuExtra) => {
    showContextMenuAt(x, y, getWindowMenuItems(w, extra));
  }, [showContextMenuAt, getWindowMenuItems]);

  const getTabMenuItems = useCallback((tabId: string): ContextMenuItem[] => {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return [];
    const items: ContextMenuItem[] = [];
    const windowId = deps.resolveTabWindow?.(tab);
    if (windowId != null && deps.maximizeWindow) items.push({ label: t('maximize.action'), onClick: () => deps.maximizeWindow?.(windowId) });
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
  }, [tabs, closeTab, findTaskByTarget, openTask, togglePin, deps.resolveTabWindow, deps.maximizeWindow]);

  const handleTabContextMenu = useCallback((e: React.MouseEvent, tabId: string) => {
    const items = getTabMenuItems(tabId);
    if (items.length > 0) showContextMenu(e, items);
  }, [getTabMenuItems, showContextMenu]);

  const handleTabLongPress = useCallback((x: number, y: number, tabId: string) => {
    const items = getTabMenuItems(tabId);
    if (items.length > 0) showContextMenuAt(x, y, items);
  }, [getTabMenuItems, showContextMenuAt]);

  return {
    wakeDialog: wake.dialog,
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
