import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { useNotificationChannel } from './useNotificationChannel';
import { useServerStatuses } from './useServerStatuses';
import type { InstallStep } from '../components/ui';
import type { PersistedTab } from './useTabPersistence';
import { useToast } from './useToast';
import { useConfirm } from './useConfirm';

export interface Server {
  name: string;
  type: string;
  host?: string;
  agentPort?: number;
  hasAgentToken?: boolean;
  agentVersion?: string;
  sshHost?: string;
  muxRuntime?: 'system' | 'managed';
  hubVersion?: string;
  /** Issue #29: declared isolation intent — see servers.isolationIntent's server-side doc comment. */
  isolationIntent?: boolean;
  /** ISO timestamp of the isolation doctor's last check, or null/undefined if never run. */
  isolationVerifiedAt?: string | null;
}

export interface Pane {
  index: number;
  title: string;
  command: string;
  width: number;
  height: number;
  active: boolean;
}

export interface TmuxWindow {
  index: number;
  name: string;
  panes: Pane[];
  activity?: number;
}

export interface Session {
  name: string;
  attached: boolean;
  windowCount: number;
  windows: TmuxWindow[];
}

export interface ServerStatus {
  status: 'online' | 'offline' | 'error' | 'checking';
  tmux: boolean;
  tmuxVersion?: string;
  agentVersion?: string;
  hubVersion?: string;
  versionMatch?: boolean;
  message?: string;
}

interface UseServerManagementParams {
  tabs: PersistedTab[];
  closeTab: (tabId: string) => void;
}

export function useServerManagement({ tabs, closeTab }: UseServerManagementParams) {
  const { t } = useTranslation('servers');
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const closeTabRef = useRef(closeTab);
  closeTabRef.current = closeTab;

  const { refresh: refreshStatuses } = useServerStatuses();
  const { showToast } = useToast();
  const confirm = useConfirm();

  const [sessions, setSessions] = useState<Record<string, Session[]>>({});
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());

  const [addServerModal, setAddServerModal] = useState(false);
  const [addName, setAddName] = useState('');
  const [addAutoInstall, setAddAutoInstall] = useState(true);
  const [addType, setAddType] = useState<'agent'>('agent');
  const [addHost, setAddHost] = useState('');
  const [addPort, setAddPort] = useState('3002');
  const [addToken, setAddToken] = useState('');
  const [addMuxRuntime, setAddMuxRuntime] = useState<'system' | 'managed'>('system');
  const [addInstallSteps, setAddInstallSteps] = useState<InstallStep[]>([]);
  const [addLoading, setAddLoading] = useState(false);

  const [editServer, setEditServer] = useState<Server | null>(null);
  const [editType, setEditType] = useState<'agent'>('agent');
  const [editHost, setEditHost] = useState('');
  const [editPort, setEditPort] = useState('3002');
  const [editToken, setEditToken] = useState('');
  const [editMuxRuntime, setEditMuxRuntime] = useState<'system' | 'managed'>('system');
  // Issue #29 review (3rd pass), Important finding 4: mirrors
  // useServerEditForm's editIsolationIntent (ServersListPage's edit path,
  // distinct from ServerDetailPage's).
  const [editIsolationIntent, setEditIsolationIntent] = useState(false);

  const [reinstalling, setReinstalling] = useState<string | null>(null);
  const [reinstallSteps, setReinstallSteps] = useState<InstallStep[]>([]);

  const refreshAll = useCallback(async () => {
    // サーバー一覧は ServerStatusProvider の refresh から受け取る（/servers の重複取得を避ける）。
    // refresh は /servers 取得のみを待って即 resolve する（各サーバーのステータス探査は
    // バックグラウンドで進み、世代ガードにより古い結果は破棄される）ため、到達不能なサーバーが
    // 混ざっていてもここでの待ち時間には影響しない。
    // refresh が失敗した場合はサーバー一覧が取得できないため、セッション取得はスキップする
    // （既存の sessions/tabs 状態は維持する）。
    let srvs: Server[];
    try {
      srvs = await refreshStatuses();
    } catch (err) {
      console.warn('[useServerManagement] refreshAll: refreshStatuses failed:', err);
      return;
    }
    const successfulServers = new Set<string>();
    const results = await Promise.allSettled(
      srvs.map(async (srv) => {
        const result = await api<Session[]>(`/servers/${srv.name}/sessions`);
        return { name: srv.name, sessions: Array.isArray(result) ? result : [] };
      }),
    );
    const newSessions: Record<string, Session[]> = {};
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled') {
        newSessions[r.value.name] = r.value.sessions;
        successfulServers.add(r.value.name);
      } else {
        newSessions[srvs[i]?.name] = [];
      }
    }
    setSessions(newSessions);

    for (const tab of tabsRef.current) {
      if (tab.type !== 'terminal') continue;
      const slashIdx = tab.id.indexOf('/');
      if (slashIdx === -1) continue;
      const serverName = tab.id.slice('terminal:'.length, slashIdx);
      if (!successfulServers.has(serverName)) continue;
      const target = tab.id.slice(slashIdx + 1);
      const colonIdx = target.indexOf(':');
      if (colonIdx === -1) continue;
      const sessionName = target.slice(0, colonIdx);
      const windowPart = target.slice(colonIdx + 1).split('.')[0];
      const session = newSessions[serverName]?.find((s) => s.name === sessionName);
      if (!session) { closeTabRef.current(tab.id); continue; }
      const idx = parseInt(windowPart, 10);
      const windowExists = Number.isNaN(idx)
        ? session.windows.some((w) => w.name === windowPart)
        : session.windows.some((w) => w.index === idx);
      if (!windowExists) closeTabRef.current(tab.id);
    }
  }, [refreshStatuses]);

  // Event-driven refresh via WebSocket
  useNotificationChannel({
    onSessionsUpdated: useCallback(() => {
      refreshAll();
    }, [refreshAll]),
  });

  // Initial fetch + fallback polling (60s safety net)
  useEffect(() => {
    refreshAll();
    const interval = setInterval(refreshAll, 60000);
    return () => clearInterval(interval);
  }, [refreshAll]);

  const toggleSession = useCallback((sessionId: string) => {
    setExpandedSessions((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId); else next.add(sessionId);
      return next;
    });
  }, []);

  const handleAddServer = useCallback(async () => {
    if (!addName.trim()) return showToast('Name is required');
    if (!addHost.trim()) return showToast('Host is required');

    if (addAutoInstall) {
      setAddLoading(true);
      setAddInstallSteps([]);
      const res = await api<{ ok?: boolean; error?: string; steps?: InstallStep[]; type?: string; fallback?: boolean; startMethod?: string }>('/servers', {
        method: 'POST',
        body: JSON.stringify({ name: addName.trim(), host: addHost.trim(), autoInstall: true }),
      });
      setAddLoading(false);
      if (res.steps) setAddInstallSteps(res.steps);
      if (res.error && !res.fallback) return showToast(res.error);
      if (res.fallback) {
        showToast(`Agent install failed: ${res.error}. Server registered as SSH instead.`);
      }
      if (res.type === 'agent' && res.startMethod === 'nohup') {
        showToast('Agent started via nohup (systemd unavailable). Manual restart required after server reboot.');
      }
      setAddServerModal(false);
      setAddName(''); setAddHost(''); setAddAutoInstall(true);
      setAddType('agent'); setAddPort('3002'); setAddToken('');
      setAddInstallSteps([]);
      refreshAll();
      return;
    }

    if (addType === 'agent') {
      if (!addPort.trim()) return showToast('Port is required');
      if (!addToken.trim()) return showToast('Token is required');
    }
    const body: Record<string, unknown> = {
      name: addName.trim(),
      type: addType,
      host: addHost.trim(),
      muxRuntime: addMuxRuntime,
    };
    if (addType === 'agent') {
      body.agentPort = parseInt(addPort.trim(), 10);
      body.agentToken = addToken.trim();
    }
    const res = await api<{ error?: string }>('/servers', {
      method: 'POST', body: JSON.stringify(body),
    });
    if (res.error) return showToast(res.error);
    setAddServerModal(false); setAddName(''); setAddHost('');
    setAddAutoInstall(true); setAddType('agent'); setAddPort('3002'); setAddToken('');
    setAddMuxRuntime('system');
    refreshAll();
  }, [addName, addHost, addAutoInstall, addType, addPort, addToken, addMuxRuntime, refreshAll, showToast]);

  const openEditModal = useCallback((srv: Server) => {
    setEditServer(srv);
    setEditType('agent');
    setEditHost(srv.host ?? '');
    setEditPort(String(srv.agentPort ?? '3002'));
    setEditToken('');
    setEditMuxRuntime(srv.muxRuntime ?? 'system');
    setEditIsolationIntent(srv.isolationIntent ?? false);
  }, []);

  const handleEditServer = useCallback(async () => {
    if (!editServer) return;
    if (!editHost.trim()) return showToast('Host is required');
    if (editType === 'agent') {
      if (!editPort.trim()) return showToast('Port is required');
    }
    const body: Record<string, unknown> = {
      type: editType,
      host: editHost.trim(),
      muxRuntime: editMuxRuntime,
    };
    if (editType === 'agent') {
      body.agentPort = parseInt(editPort.trim(), 10);
      if (editToken.trim()) {
        body.agentToken = editToken.trim();
      }
      body.isolationIntent = editIsolationIntent;
    }
    const res = await api<{ error?: string; windowCount?: number; sessionCount?: number; isolationCleanup?: 'done' | 'failed' | 'skipped' }>(`/servers/${editServer.name}`, {
      method: 'PUT', body: JSON.stringify(body),
    });
    if (res.error) {
      // Issue #29 review, Critical finding 1: see useServerEditForm's
      // identical handling — this hook drives the other edit path
      // (ServersListPage) and must surface the same localized toast.
      // Issue #29 review (5th pass), Critical finding 1: same live-session
      // gate cases as useServerEditForm — see that hook's comment.
      if (res.error === 'isolation_intent_blocked_by_windows') {
        return showToast(t('overview.isolationBlockedByWindowsToast', { count: res.windowCount ?? 0 }));
      }
      if (res.error === 'isolation_intent_blocked_by_live_sessions') {
        return showToast(t('overview.isolationBlockedByLiveSessionsToast', { count: res.sessionCount ?? 0 }));
      }
      if (res.error === 'isolation_intent_blocked_by_session_check_failure') {
        return showToast(t('overview.isolationBlockedBySessionCheckFailureToast'));
      }
      if (res.error === 'isolation_intent_blocks_connection_change') {
        // Issue #29 review (8th pass), Critical finding 1: see
        // useServerEditForm's identical handling.
        return showToast(t('overview.isolationBlocksConnectionChangeToast'));
      }
      return showToast(res.error);
    }
    // Issue #29 review (3rd pass), Important finding 4: see
    // useServerEditForm's identical handling — this hook drives the other
    // edit path (ServersListPage) and must surface the same outcome.
    if (res.isolationCleanup === 'failed') showToast(t('overview.isolationCleanupToastFailed'));
    else if (res.isolationCleanup === 'skipped') showToast(t('overview.isolationCleanupToastSkipped'));
    setEditServer(null);
    refreshAll();
  }, [editServer, editType, editHost, editPort, editToken, editMuxRuntime, editIsolationIntent, refreshAll, showToast, t]);

  const handleReinstall = useCallback(async (serverName: string) => {
    const ok = await confirm({ title: t('confirm.reinstallAgent'), message: t('confirm.reinstallAgentMessage', { name: serverName }) });
    if (!ok) return;
    setReinstalling(serverName);
    setReinstallSteps([]);
    const res = await api<{ ok?: boolean; error?: string; steps?: InstallStep[] }>(
      `/servers/${serverName}/agent/install`,
      { method: 'POST' },
    );
    if (res.steps) setReinstallSteps(res.steps);
    setReinstalling(null);
    if (res.error) showToast(`Reinstall failed: ${res.error}`);
    refreshAll();
  }, [refreshAll, confirm, showToast, t]);

  const removeServer = useCallback(async (name: string) => {
    const ok = await confirm({ title: t('confirm.removeServer'), message: t('confirm.removeServerMessage', { name }), danger: true });
    if (!ok) return;
    const res = await api<{ error?: string }>(`/servers/${name}`, { method: 'DELETE' });
    if (res.error) return showToast(res.error);
    tabs.filter((t) => t.type === 'terminal' && t.serverName === name).forEach((t) => closeTab(t.id));
    refreshAll();
  }, [refreshAll, tabs, closeTab, confirm, showToast, t]);

  const createSession = useCallback(async (serverName: string) => {
    const name = prompt('New session name:');
    if (!name) return;
    const command = prompt('Initial command (optional):', '');
    await api(`/servers/${serverName}/sessions`, { method: 'POST', body: JSON.stringify({ name, command: command || undefined }) });
    refreshAll();
  }, [refreshAll]);

  const handleRenameSession = useCallback(async (serverName: string, sessionName: string) => {
    const newName = prompt('Rename session:', sessionName);
    if (!newName || newName === sessionName) return;
    await api(`/servers/${serverName}/sessions/${sessionName}/rename`, { method: 'PUT', body: JSON.stringify({ name: newName }) });
    refreshAll();
  }, [refreshAll]);

  const handleKillSession = useCallback(async (serverName: string, sessionName: string) => {
    const ok = await confirm({ title: t('confirm.killSession'), message: t('confirm.killSessionMessage', { name: sessionName }), danger: true });
    if (!ok) return;
    await api(`/servers/${serverName}/sessions/${sessionName}`, { method: 'DELETE' });
    tabs.filter((t) => t.id.startsWith(`terminal:${serverName}/${sessionName}:`)).forEach((t) => closeTab(t.id));
    refreshAll();
  }, [refreshAll, tabs, closeTab, confirm, t]);

  const handleAddWindow = useCallback(async (serverName: string, sessionName: string) => {
    await api(`/servers/${serverName}/sessions/${sessionName}/windows`, { method: 'POST' });
    refreshAll();
  }, [refreshAll]);

  const handleSplitPane = useCallback(async (serverName: string, sessionName: string, windowName: string, direction: string) => {
    await api(`/servers/${serverName}/sessions/${sessionName}/windows/${encodeURIComponent(windowName)}/panes`, { method: 'POST', body: JSON.stringify({ direction }) });
    refreshAll();
  }, [refreshAll]);

  const handleRenameWindow = useCallback(async (serverName: string, target: string, currentName: string) => {
    const newName = prompt('Rename window:', currentName);
    if (!newName || newName === currentName) return;
    await api(`/servers/${serverName}/windows/${encodeURIComponent(target)}/rename`, { method: 'PUT', body: JSON.stringify({ name: newName }) });
    refreshAll();
  }, [refreshAll]);

  const handleRenamePane = useCallback(async (serverName: string, target: string, currentTitle: string) => {
    const newTitle = prompt('Rename pane:', currentTitle);
    if (!newTitle || newTitle === currentTitle) return;
    await api(`/servers/${serverName}/panes/${encodeURIComponent(target)}/rename`, { method: 'PUT', body: JSON.stringify({ title: newTitle }) });
    refreshAll();
  }, [refreshAll]);

  const handleKillWindow = useCallback(async (serverName: string, target: string) => {
    const ok = await confirm({ title: t('confirm.killWindow'), message: t('confirm.killWindowMessage', { name: target }), danger: true });
    if (!ok) return;
    await api(`/servers/${serverName}/windows/${encodeURIComponent(target)}`, { method: 'DELETE' });
    tabs.filter((t) => t.id.startsWith(`terminal:${serverName}/${target}.`)).forEach((t) => closeTab(t.id));
    refreshAll();
  }, [refreshAll, tabs, closeTab, confirm, t]);

  const handleKillPane = useCallback(async (serverName: string, target: string) => {
    const ok = await confirm({ title: t('confirm.killPane'), message: t('confirm.killPaneMessage', { name: target }), danger: true });
    if (!ok) return;
    await api(`/servers/${serverName}/panes/${encodeURIComponent(target)}`, { method: 'DELETE' });
    closeTab(`terminal:${serverName}/${target}`);
    refreshAll();
  }, [refreshAll, closeTab, confirm, t]);

  return {
    sessions,
    expandedSessions,
    refreshAll,
    toggleSession,
    handleAddServer,
    openEditModal,
    handleEditServer,
    handleReinstall,
    removeServer,
    createSession,
    handleRenameSession,
    handleKillSession,
    handleAddWindow,
    handleSplitPane,
    handleRenameWindow,
    handleRenamePane,
    handleKillWindow,
    handleKillPane,
    addServerModal, setAddServerModal,
    addName, setAddName,
    addAutoInstall, setAddAutoInstall,
    addType, setAddType,
    addHost, setAddHost,
    addPort, setAddPort,
    addToken, setAddToken,
    addMuxRuntime, setAddMuxRuntime,
    addInstallSteps, setAddInstallSteps,
    addLoading,
    editServer, setEditServer,
    editType, setEditType,
    editHost, setEditHost,
    editPort, setEditPort,
    editToken, setEditToken,
    editMuxRuntime, setEditMuxRuntime,
    editIsolationIntent, setEditIsolationIntent,
    reinstalling,
    reinstallSteps,
  };
}
