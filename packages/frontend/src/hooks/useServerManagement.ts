import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { useNotificationChannel } from './useNotificationChannel';
import { useServerStatuses } from './useServerStatuses';
import type { InstallStep } from '../components/ui';
import type { PersistedTab } from './useTabPersistence';
import { useToast } from './useToast';
import { useConfirm } from './useConfirm';
import type { MuxDriverKind, MuxPaneProcessState, MuxRuntime, MuxStatusItem } from '@azito/shared';
import { defaultMuxOptions, editableDefaultMux, editableMuxRuntime } from '../lib/muxRuntimeForm';
import { refUsesMuxRoutes, usesMuxRoutes } from '../lib/sessionKind';
import { fetchSessionListing, keepUnavailableKinds } from '../lib/fetchServerSessions';
import { muxCreateFailureText } from '../lib/muxKindChoice';

export interface Server {
  name: string;
  type: string;
  host?: string;
  agentPort?: number;
  hasAgentToken?: boolean;
  agentVersion?: string;
  sshHost?: string;
  defaultMux: MuxDriverKind;
  /** Old names of servers merged into this one (migration 079); saved tabs are re-pointed. TODO(#313): remove after one release. */
  aliases?: string[];
  muxRuntime?: MuxRuntime;
  hubVersion?: string;
  /** Issue #29: declared isolation intent — see servers.isolationIntent's server-side doc comment. */
  isolationIntent?: boolean;
  /** ISO timestamp of the isolation doctor's last check, or null/undefined if never run. */
  isolationVerifiedAt?: string | null;
}

export interface Pane {
  index: number;
  /** Stable pane handle; unlike `index` it does not shift when a sibling pane is deleted. */
  handle?: string;
  title: string;
  command: string;
  width: number;
  height: number;
  active: boolean;
  /** Reported by the misao driver only; absent for tmux panes. */
  processState?: MuxPaneProcessState;
}

export interface TmuxWindow {
  index: number;
  name: string;
  panes: Pane[];
  activity?: number;
  ref: string;
  windowId: number | null;
}

export interface Session {
  name: string;
  /** The mux the session lives in (a tmux and a misao session can share a name). See lib/sessionKind.ts. */
  kind?: MuxDriverKind;
  /** Kept from an earlier listing because its mux could not be listed now (see keepUnavailableKinds). */
  stale?: boolean;
  attached: boolean;
  windowCount: number;
  windows: TmuxWindow[];
}

export interface ServerStatus {
  status: 'online' | 'offline' | 'error' | 'checking';
  /** One entry per mux kind the server can host (absent while checking or when the check failed). */
  mux?: Partial<Record<MuxDriverKind, MuxStatusItem>>;
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
  const { t: tw } = useTranslation('workspace');
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const closeTabRef = useRef(closeTab);
  closeTabRef.current = closeTab;

  const { servers, refresh: refreshStatuses } = useServerStatuses();

  // What a call without a kind means: the server's default mux (where a new session is created).
  const defaultKindOf = useCallback((serverName: string): MuxDriverKind => {
    const srv = servers.find((s) => s.name === serverName);
    return srv ? srv.defaultMux : 'tmux';
  }, [servers]);
  // A session-level call acts on the session of `kind` (sessions of two muxes can share a name); omitted = default mux.
  const sessionUsesMuxRoutes = useCallback((serverName: string, kind?: MuxDriverKind): boolean =>
    usesMuxRoutes(kind ?? defaultKindOf(serverName)), [defaultKindOf]);
  const kindQuery = (kind?: MuxDriverKind): string => (kind ? `?kind=${kind}` : '');
  const { showToast } = useToast();
  const confirm = useConfirm();

  const [sessions, setSessions] = useState<Record<string, Session[]>>({});
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());

  const [addServerModal, setAddServerModal] = useState(false);
  const [addName, setAddName] = useState('');
  const [addAutoInstall, setAddAutoInstall] = useState(true);
  const [addType, setAddType] = useState<'agent'>('agent');
  const [addHost, setAddHost] = useState('');
  const [addPort, setAddPort] = useState('3002');
  const [addToken, setAddToken] = useState('');
  const [addMuxRuntime, setAddMuxRuntime] = useState<MuxRuntime>('system');
  const [addInstallSteps, setAddInstallSteps] = useState<InstallStep[]>([]);
  const [addLoading, setAddLoading] = useState(false);

  const [editServer, setEditServer] = useState<Server | null>(null);
  const [editType, setEditType] = useState<'agent'>('agent');
  const [editHost, setEditHost] = useState('');
  const [editPort, setEditPort] = useState('3002');
  const [editToken, setEditToken] = useState('');
  const [editMuxRuntime, setEditMuxRuntime] = useState<MuxRuntime>('system');
  const [editDefaultMux, setEditDefaultMux] = useState<MuxDriverKind>('tmux');
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
        // エラー本文（503 agent_unreachable 等）は一覧でないため失敗扱いにする（空配列の成功と取り違えてタブを閉じない）。
        // 一覧できなかった mux（misao デーモン停止など）のセッションは直前の状態を保つ（削除扱いにしない）
        const result = keepUnavailableKinds(sessionsRef.current[srv.name], await fetchSessionListing<Session>(srv.name));
        // 遅いサーバー 1 台を待たず、取得できたサーバーから 1 台ずつ反映する
        setSessions((prev) => ({ ...prev, [srv.name]: result }));
        return { name: srv.name, sessions: result };
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
      if (tab.type !== 'terminal' || !tab.serverName) continue;
      if (!successfulServers.has(tab.serverName)) continue;
      const serverSessions = newSessions[tab.serverName];
      if (!serverSessions) continue;

      if (tab.terminalRef) {
        const ref = tab.terminalRef;
        if (ref.kind === 'windowId') {
          const exists = serverSessions.some((s) => s.windows.some((w) => w.windowId === ref.windowId));
          if (!exists) closeTabRef.current(tab.id);
        } else {
          const exists = serverSessions.some((s) => s.windows.some((w) => w.ref === ref.ref));
          if (!exists) closeTabRef.current(tab.id);
        }
        continue;
      }

      const slashIdx = tab.id.indexOf('/');
      if (slashIdx === -1) continue;
      const serverName = tab.id.slice('terminal:'.length, slashIdx);
      const target = tab.id.slice(slashIdx + 1);
      const colonIdx = target.indexOf(':');
      if (colonIdx === -1) continue;
      const sessionName = target.slice(0, colonIdx);
      const windowPart = target.slice(colonIdx + 1).split('.')[0];
      const session = serverSessions.find((s) => s.name === sessionName);
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
    setEditMuxRuntime(editableMuxRuntime(srv.muxRuntime));
    setEditDefaultMux(editableDefaultMux(srv.defaultMux, defaultMuxOptions(srv.type)));
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
      defaultMux: editDefaultMux,
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
  }, [editServer, editType, editHost, editPort, editToken, editMuxRuntime, editDefaultMux, editIsolationIntent, refreshAll, showToast, t]);

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
    if (res.error) {
      // Issue #29 review, 14th pass, Important finding 2: the server now
      // rejects agent-install on an isolated server with this error code
      // (see routes.ts's doc comment) — give it the same localized toast
      // treatment as the PUT handler's isolation gates instead of showing
      // the raw error code.
      if (res.error === 'isolation_intent_blocks_agent_install') {
        showToast(t('overview.isolationBlocksAgentInstallToast'));
      } else {
        showToast(`Reinstall failed: ${res.error}`);
      }
    }
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
    if (!sessionUsesMuxRoutes(serverName)) {
      const command = prompt('Initial command (optional):', '');
      await api(`/servers/${serverName}/sessions`, { method: 'POST', body: JSON.stringify({ name, command: command || undefined }) });
    } else {
      await api(`/servers/${encodeURIComponent(serverName)}/mux/workspaces`, { method: 'POST', body: JSON.stringify({ name }) });
    }
    refreshAll();
  }, [refreshAll, sessionUsesMuxRoutes]);

  const handleRenameSession = useCallback(async (serverName: string, sessionName: string, kind?: MuxDriverKind) => {
    const newName = prompt('Rename session:', sessionName);
    if (!newName || newName === sessionName) return;
    if (!sessionUsesMuxRoutes(serverName, kind)) {
      await api(`/servers/${serverName}/sessions/${sessionName}/rename`, { method: 'PUT', body: JSON.stringify({ name: newName }) });
    } else {
      await api(`/servers/${encodeURIComponent(serverName)}/mux/workspaces/${encodeURIComponent(sessionName)}/rename`, { method: 'PUT', body: JSON.stringify({ name: newName, kind }) });
    }
    refreshAll();
  }, [refreshAll, sessionUsesMuxRoutes]);

  const handleKillSession = useCallback(async (serverName: string, sessionName: string, kind?: MuxDriverKind) => {
    const ok = await confirm({ title: t('confirm.killSession'), message: t('confirm.killSessionMessage', { name: sessionName }), danger: true });
    if (!ok) return;
    if (!sessionUsesMuxRoutes(serverName, kind)) {
      await api(`/servers/${serverName}/sessions/${sessionName}`, { method: 'DELETE' });
    } else {
      await api(`/servers/${encodeURIComponent(serverName)}/mux/workspaces/${encodeURIComponent(sessionName)}${kindQuery(kind)}`, { method: 'DELETE' });
    }
    tabs.filter((t) => t.id.startsWith(`terminal:${serverName}/${sessionName}:`)).forEach((t) => closeTab(t.id));
    refreshAll();
  }, [refreshAll, tabs, closeTab, confirm, t, sessionUsesMuxRoutes]);

  const handleAddWindow = useCallback(async (serverName: string, sessionName: string, kind?: MuxDriverKind) => {
    const res = await api<unknown>(`/servers/${encodeURIComponent(serverName)}/mux/workspaces/${encodeURIComponent(sessionName)}/windows`, { method: 'POST', body: JSON.stringify({ kind: kind ?? defaultKindOf(serverName) }) });
    const failure = muxCreateFailureText(res, tw);
    if (failure !== null) {
      showToast(failure);
      return;
    }
    refreshAll();
  }, [refreshAll, defaultKindOf, showToast, tw]);

  const handleSplitPane = useCallback(async (serverName: string, sessionName: string, windowName: string, direction: string, windowId?: number, ref?: string) => {
    if (windowId != null) {
      await api(`/windows/${windowId}/panes`, { method: 'POST', body: JSON.stringify({ direction }) });
    } else if (refUsesMuxRoutes(ref)) {
      await api(`/servers/${encodeURIComponent(serverName)}/mux/windows/${encodeURIComponent(ref)}/panes`, { method: 'POST', body: JSON.stringify({ direction }) });
    } else {
      await api(`/servers/${serverName}/sessions/${sessionName}/windows/${encodeURIComponent(windowName)}/panes`, { method: 'POST', body: JSON.stringify({ direction }) });
    }
    refreshAll();
  }, [refreshAll]);

  const handleRenameWindow = useCallback(async (serverName: string, target: string, currentName: string, windowId?: number, ref?: string) => {
    const newName = prompt('Rename window:', currentName);
    if (!newName || newName === currentName) return;
    if (windowId != null) {
      await api(`/windows/${windowId}/rename`, { method: 'PUT', body: JSON.stringify({ name: newName }) });
    } else if (refUsesMuxRoutes(ref)) {
      await api(`/servers/${encodeURIComponent(serverName)}/mux/windows/${encodeURIComponent(ref)}/rename`, { method: 'PUT', body: JSON.stringify({ name: newName }) });
    } else {
      await api(`/servers/${serverName}/windows/${encodeURIComponent(target)}/rename`, { method: 'PUT', body: JSON.stringify({ name: newName }) });
    }
    refreshAll();
  }, [refreshAll]);

  const handleRenamePane = useCallback(async (serverName: string, target: string, currentTitle: string, windowId?: number, paneOrdinal?: number, ref?: string) => {
    const newTitle = prompt('Rename pane:', currentTitle);
    if (!newTitle || newTitle === currentTitle) return;
    if (windowId != null && paneOrdinal != null) {
      await api(`/windows/${windowId}/panes/${paneOrdinal}/rename`, { method: 'PUT', body: JSON.stringify({ title: newTitle }) });
    } else if (refUsesMuxRoutes(ref) && paneOrdinal != null) {
      await api(`/servers/${encodeURIComponent(serverName)}/mux/windows/${encodeURIComponent(ref)}/panes/${paneOrdinal}/rename`, { method: 'PUT', body: JSON.stringify({ name: newTitle }) });
    } else {
      await api(`/servers/${serverName}/panes/${encodeURIComponent(target)}/rename`, { method: 'PUT', body: JSON.stringify({ title: newTitle }) });
    }
    refreshAll();
  }, [refreshAll]);

  const handleKillWindow = useCallback(async (serverName: string, target: string, windowId?: number, ref?: string) => {
    const ok = await confirm({ title: t('confirm.killWindow'), message: t('confirm.killWindowMessage', { name: target }), danger: true });
    if (!ok) return;
    if (windowId != null) {
      await api(`/windows/${windowId}/kill`, { method: 'DELETE' });
    } else if (refUsesMuxRoutes(ref)) {
      await api(`/servers/${encodeURIComponent(serverName)}/mux/windows/${encodeURIComponent(ref)}/kill`, { method: 'POST' });
    } else {
      await api(`/servers/${serverName}/windows/${encodeURIComponent(target)}`, { method: 'DELETE' });
    }
    tabs.filter((t) => t.type === 'terminal' && t.serverName === serverName && t.target && (t.target === target || t.target.startsWith(`${target}.`))).forEach((t) => closeTab(t.id));
    refreshAll();
  }, [refreshAll, tabs, closeTab, confirm, t]);

  const handleKillPane = useCallback(async (serverName: string, target: string, windowId?: number, paneOrdinal?: number, ref?: string) => {
    const ok = await confirm({ title: t('confirm.killPane'), message: t('confirm.killPaneMessage', { name: target }), danger: true });
    if (!ok) return;
    if (windowId != null && paneOrdinal != null) {
      await api(`/windows/${windowId}/panes/${paneOrdinal}`, { method: 'DELETE' });
    } else if (refUsesMuxRoutes(ref) && paneOrdinal != null) {
      await api(`/servers/${encodeURIComponent(serverName)}/mux/windows/${encodeURIComponent(ref)}/panes/${paneOrdinal}`, { method: 'DELETE' });
    } else {
      await api(`/servers/${serverName}/panes/${encodeURIComponent(target)}`, { method: 'DELETE' });
    }
    const matchTarget = (tab: PersistedTab) =>
      tab.type === 'terminal' && tab.serverName === serverName && (
        tab.id === `terminal:${serverName}/${target}` ||
        (windowId != null && paneOrdinal != null && tab.id === `terminal:${serverName}::w${windowId}.${paneOrdinal}`)
      );
    const matchingTab = tabs.find(matchTarget);
    if (matchingTab) closeTab(matchingTab.id);
    refreshAll();
  }, [refreshAll, tabs, closeTab, confirm, t]);

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
    editDefaultMux, setEditDefaultMux,
    editIsolationIntent, setEditIsolationIntent,
    reinstalling,
    reinstallSteps,
  };
}
