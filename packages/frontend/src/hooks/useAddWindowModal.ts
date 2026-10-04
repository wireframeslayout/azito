import { useState, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api } from '../api/client';
import type { MuxDriverKind } from '@azito/shared';
import type { Project, Server, Session } from '../pages/workspace/types';
import type { ResourceStatus } from '../components/ResourceWarningDialog';
import { resolveWindowRegistrationRef, registeredWindowTerminalRef, taskWindowRegistration, type TerminalRef } from '../lib/terminalRef';
import { useAgentDefinitions, type AgentDefinition } from './useAgentDefinitions';
import { useToast } from './useToast';
import { useServerStatuses } from './useServerStatuses';
import { fetchSessionsForServers } from '../lib/fetchServerSessions';
import { findSessionByKey, sessionKindOf, windowTargetSelectOptions } from '../lib/sessionKind';
import { isMuxKindUnavailable, muxKindReason, muxKindSelectModel } from '../lib/muxKindChoice';
import { errorMessageOf } from '../lib/apiResult';
import { useMuxKindAvailability } from './useMuxKindAvailability';

/** 409 insufficient_resources レスポンス（api() はステータスを返さないため body のマーカーで判定する） */
export function isInsufficientResources(res: unknown): res is { error: string; resources: ResourceStatus } {
  return typeof res === 'object' && res !== null
    && (res as Record<string, unknown>)['error'] === 'insufficient_resources';
}

/** 409 window_exists レスポンス */
export function isWindowExists(res: unknown): res is { error: string; windowName: string } {
  return typeof res === 'object' && res !== null
    && (res as Record<string, unknown>)['error'] === 'window_exists';
}

/** The 201 body of `POST /mux/workspaces[/:ws/windows]`. */
interface MuxCreateResponse { ok: boolean; ref: string; target: string; windowName: string }

export type AgentPreset = { command: string; label: string };

/** 起動コマンド選択肢（シェルのみ / 起動可能な各エージェント / カスタム）。ウィンドウ追加とペイン追加で共通。 */
export function buildAgentPresets(agentDefs: AgentDefinition[], t: TFunction<'workspace'>): Record<string, AgentPreset> {
  const map: Record<string, AgentPreset> = {
    none: { command: '', label: t('addWindow.noneShellOnly') },
  };
  for (const def of agentDefs) {
    if (def.launchable) {
      map[def.type] = { command: def.launchCommand ?? '', label: def.label };
    }
  }
  map.custom = { command: '', label: t('addWindow.customCommand') };
  return map;
}

/**
 * agent の起動コマンドを組み立てる。`baseCommand` はサーバー(AgentRegistry)由来の
 * モデル/追加引数なし起動コマンド。'none' / 'custom' はエージェント種別ではなく
 * UI 専用の仮想選択肢なので、ここでのみ特別扱いする。
 */
export function buildAgentCommand(
  agent: string,
  model: string,
  baseCommand: string,
  customCommand?: string,
): string {
  if (agent === 'none') return '';
  if (agent === 'custom') return (customCommand || '').trim();
  let cmd = baseCommand;
  if (model) cmd += ` --model '${model.replace(/'/g, "'\\''")}'`;
  return cmd;
}

export type TaskWindowExtra = { windowType?: string; workerType?: string; workerModel?: string; workingDirectory?: string };

export type QuickAddAgent = 'claude' | 'codex' | 'terminal';

export function useAddWindowModal(
  projectId: string | undefined,
  project: Project | null,
  servers: Server[],
  projectServers: { serverName: string; workingDirectory?: string }[],
  refreshWorkspace: () => void,
  refreshSessions?: () => Promise<void>,
  onConnect?: (refOrServerName: TerminalRef | string, targetOrProjectId?: string | number, projectId?: number) => void,
  onTaskWindowAdded?: (taskId: number, serverName: string, tmuxTarget: string, label: string, activate: boolean, extra?: TaskWindowExtra & { ref?: string }) => Promise<void>,
) {
  const [addWindowOpen, setAddWindowOpen] = useState(false);
  const [awMode, setAwMode] = useState<'existing' | 'session' | 'new'>('existing');
  const [awServer, setAwServerState] = useState('');
  // The mux the user picked for a new window; null until they pick (the server's default applies).
  const [awMuxChoice, setAwMuxChoice] = useState<MuxDriverKind | null>(null);
  const [awTarget, setAwTarget] = useState('');
  const [awLabel, setAwLabel] = useState('');
  const [awSessionData, setAwSessionData] = useState<Record<string, Session[]>>({});
  const [awOfflineServers, setAwOfflineServers] = useState<string[]>([]);
  const [awSelectedSession, setAwSelectedSession] = useState('');
  const [awNewSession, setAwNewSession] = useState('');
  const [awNewWindowName, setAwNewWindowName] = useState('');
  const [awNewCommand, setAwNewCommand] = useState('');
  const [awWorkDir, setAwWorkDir] = useState('');
  const [awAgent, setAwAgent] = useState('none');
  const [awAgentModel, setAwAgentModel] = useState('');
  const [awWorkerModels, setAwWorkerModels] = useState<{ id: string; label: string }[]>([]);
  const [addWindowLoading, setAddWindowLoading] = useState(false);
  const [awTaskId, setAwTaskId] = useState<number | null>(null);
  const [awEffectiveProjectId, setAwEffectiveProjectId] = useState<string | undefined>(undefined);
  const [awEffectiveProjectServers, setAwEffectiveProjectServers] = useState<{ serverName: string; workingDirectory?: string }[] | undefined>(undefined);
  const [awEffectiveProject, setAwEffectiveProject] = useState<Project | undefined>(undefined);
  const [awResourceWarning, setAwResourceWarning] = useState<{ resources: ResourceStatus; retry: () => void } | null>(null);
  const [awQuickAddOpen, setAwQuickAddOpen] = useState(false);
  const [awQuickAddAgent, setAwQuickAddAgent] = useState<QuickAddAgent>('terminal');
  const [awQuickAddLoading, setAwQuickAddLoading] = useState(false);
  // クイック追加の呼び出し世代。連打時、後発の呼び出しだけが自分の取得結果を state に反映できるようにする。
  const awQuickAddGenRef = useRef(0);

  const { t } = useTranslation('workspace');
  const { agents: agentDefs, loading: agentDefsLoading, error: agentDefsError } = useAgentDefinitions('worker');
  const { showToast } = useToast();
  const { statuses } = useServerStatuses();
  const isServerOffline = useCallback((name: string) => statuses[name]?.status === 'offline', [statuses]);

  const awServerInfo = servers.find((s) => s.name === awServer);
  const muxAvailability = useMuxKindAvailability(awServerInfo, addWindowOpen || awQuickAddOpen);
  const muxKindModel = awServerInfo ? muxKindSelectModel(awServerInfo, muxAvailability, awMuxChoice) : null;

  /** Switching the server drops the mux pick: it was made against the previous server's availability. */
  const setAwServer = useCallback((name: string) => {
    setAwServerState(name);
    setAwMuxChoice(null);
  }, []);

  const agentPresets = useMemo(() => buildAgentPresets(agentDefs, t), [agentDefs, t]);

  const handleAgentChange = useCallback(async (agent: string) => {
    setAwAgent(agent);
    setAwAgentModel('');
    if (agent === 'none' || agent === 'custom') {
      setAwWorkerModels([]);
      return;
    }
    try {
      const models = await api<{ id: string; label: string }[]>(`/workers/models/${agent}`);
      setAwWorkerModels(Array.isArray(models) ? models : []);
    } catch {
      setAwWorkerModels([]);
    }
  }, []);

  const openAddWindow = useCallback(async (
    forTask: boolean = false,
    overrideProject?: { projectId: string; project: Project; projectServers: { serverName: string; workingDirectory?: string }[] },
    taskId?: number,
  ) => {
    // クイック追加の走行中に汎用モーダルを開いた場合、先発のクイック追加取得が後から届いて
    // 汎用モーダルの awSessionData/awWorkerModels を上書きしないよう、世代を進めて無効化する。
    awQuickAddGenRef.current++;
    const effectiveProjectServers = overrideProject?.projectServers ?? projectServers;
    const effectiveProject = overrideProject?.project ?? project;
    setAwEffectiveProjectId(overrideProject?.projectId);
    setAwEffectiveProjectServers(overrideProject?.projectServers);
    setAwEffectiveProject(overrideProject?.project ?? undefined);
    const availableServers = effectiveProjectServers.length > 0
      ? servers.filter((s) => effectiveProjectServers.some((ps) => ps.serverName === s.name))
      : servers;
    const { data, offline } = await fetchSessionsForServers(availableServers, isServerOffline);
    setAwSessionData(data);
    setAwOfflineServers(offline);
    const firstServer = availableServers[0]?.name || '';
    setAwServer(firstServer);
    setAwTarget(''); setAwLabel(''); setAwMode('new');
    setAwSelectedSession('');
    const ps = effectiveProjectServers.find((p) => p.serverName === firstServer);
    setAwNewSession(effectiveProject?.slug || '');
    setAwNewWindowName(''); setAwNewCommand('');
    setAwWorkDir(ps?.workingDirectory || effectiveProject?.workingDirectory || '');
    setAwAgent('none'); setAwAgentModel(''); setAwWorkerModels([]);
    setAwTaskId(taskId ?? null);
    setAddWindowOpen(true);
  }, [servers, projectServers, project, isServerOffline, setAwServer]);

  /**
   * ServerGroup のクイック追加アイコン（claude/codex/terminal）用。サーバー・エージェント種別は
   * 呼び出し時点で確定しているため、モデル選択と作業ディレクトリだけを入力させる最小限のモーダルを開く。
   * 送信は handleAddWindow の 'new' モードをそのまま使う（同じ API・同じパラメータ組み立て）。
   */
  const openQuickAddWindow = useCallback((serverName: string, agentType: QuickAddAgent) => {
    // 世代を確定させてからモーダルを同期的に開く。連打された場合、非同期取得が届いた時点で
    // 自分がまだ最新世代かを確認し、そうでなければ結果を破棄する（先発の遅い応答が後発を上書きしない）。
    const gen = ++awQuickAddGenRef.current;
    setAwServer(serverName);
    setAwTarget(''); setAwLabel(''); setAwMode('new');
    setAwSelectedSession('');
    const ps = projectServers.find((p) => p.serverName === serverName);
    setAwNewSession(project?.slug || '');
    setAwNewWindowName(''); setAwNewCommand('');
    setAwWorkDir(ps?.workingDirectory || project?.workingDirectory || '');
    setAwTaskId(null);
    setAwEffectiveProjectId(undefined);
    setAwEffectiveProjectServers(undefined);
    setAwEffectiveProject(undefined);
    setAwQuickAddAgent(agentType);
    const agent = agentType === 'terminal' ? 'none' : agentType;
    setAwAgent(agent);
    setAwAgentModel('');
    setAwWorkerModels([]);
    setAwSessionData({});
    setAwOfflineServers([]);
    setAwQuickAddOpen(true);
    setAwQuickAddLoading(true);

    void (async () => {
      const { data, offline } = await fetchSessionsForServers([{ name: serverName }], isServerOffline);
      let models: { id: string; label: string }[] = [];
      if (agent !== 'none') {
        try {
          const m = await api<{ id: string; label: string }[]>(`/workers/models/${agent}`);
          if (Array.isArray(m)) models = m;
        } catch {}
      }
      if (awQuickAddGenRef.current !== gen) return; // 自分より後の呼び出しがある場合は破棄
      setAwSessionData(data);
      setAwOfflineServers(offline);
      setAwWorkerModels(models);
      setAwQuickAddLoading(false);
    })();
  }, [projectServers, project, isServerOffline, setAwServer]);

  /**
   * クイック追加モーダルを閉じる。世代を進めて、走行中の取得（openQuickAddWindow 内の
   * 非同期処理）が後から届いても awSessionData/awWorkerModels を上書きしないようにする。
   */
  const closeQuickAddWindow = useCallback(() => {
    awQuickAddGenRef.current++;
    setAwQuickAddOpen(false);
  }, []);

  /** 既存ウィンドウ/セッション取り込みモードへ切り替える前に、未取得でオフラインでもないサーバーのセッションを並列取得する。 */
  const loadMissingSessions = useCallback(async (): Promise<void> => {
    const missing = servers.filter((s) => !awSessionData[s.name] && !awOfflineServers.includes(s.name));
    if (missing.length === 0) return;
    const { data, offline } = await fetchSessionsForServers(missing, isServerOffline);
    setAwSessionData((prev) => ({ ...prev, ...data }));
    setAwOfflineServers((prev) => [...new Set([...prev, ...offline])]);
  }, [servers, awSessionData, awOfflineServers, isServerOffline]);

  const getWindowTargets = useCallback((): { value: string; label: string }[] =>
    windowTargetSelectOptions(awSessionData[awServer] || []), [awSessionData, awServer]);

  // launch-agent の再送（force 付き）。ウィンドウ作成後に 409 になったケースの retry 用。
  const launchAgent = useCallback(async (windowId: number, command: string, force: boolean): Promise<boolean> => {
    const res = await api<Record<string, unknown>>(`/windows/${windowId}/launch-agent`, {
      method: 'POST',
      body: JSON.stringify({ command, force }),
    });
    if (isInsufficientResources(res)) {
      setAwResourceWarning({
        resources: res.resources,
        retry: () => {
          setAwResourceWarning(null);
          void launchAgent(windowId, command, true);
        },
      });
      return false;
    }
    return true;
  }, []);

  const handleAddWindow = useCallback(async function perform(force = false) {
    if (addWindowLoading) return;
    if (awMode === 'existing') {
      if (!awTarget) return showToast(t('addWindow.selectWindowError'));
    } else if (awMode === 'session') {
      if (!awSelectedSession) return showToast(t('addWindow.selectSessionError'));
    } else {
      if (!awNewSession.trim()) return showToast(t('addWindow.sessionNameRequired'));
    }
    setAddWindowLoading(true);
    const effectiveProjectId = awEffectiveProjectId || projectId;
    const numericProjectId = effectiveProjectId ? parseInt(effectiveProjectId, 10) : undefined;
    // A new session/window is created in the mux the user picked (the server's default unless changed); an existing one is registered in its own mux.
    const newKind: MuxDriverKind = muxKindModel?.value ?? 'tmux';
    // The window is already registered on the project when the task attachment fails; surface it instead of rejecting.
    const failTaskWindow = (err: unknown): void => {
      console.error('task window add failed', err);
      showToast(t('addWindow.taskWindowAddFailed'));
    };
    try {
      if (awMode === 'session') {
        const sess = findSessionByKey(awSessionData[awServer] || [], awSelectedSession);
        if (!sess) throw new Error(`session ${awSelectedSession} is not listed on ${awServer}`);
        const sessionKind = sessionKindOf(sess);
        await api(`/projects/${effectiveProjectId}/windows/session`, { method: 'POST', body: JSON.stringify({ server_name: awServer, session: sess.name, kind: sessionKind }) });
        if (sess.windows.length > 0) {
          if (awTaskId != null) {
            try {
              for (const [index, w] of sess.windows.entries()) {
                const reg = taskWindowRegistration({ muxKind: sessionKind, target: `${sess.name}:${w.name}`, ref: w.ref });
                if (!reg) throw new Error(`window ref is not resolved for ${sess.name}:${w.name}`);
                await onTaskWindowAdded?.(awTaskId, awServer, reg.target, w.name, index === 0, reg.ref ? { ref: reg.ref } : undefined);
              }
            } catch (err) {
              failTaskWindow(err);
              return;
            }
          } else {
            const firstWin = sess.windows[0];
            const firstPane = firstWin.panes[0];
            if (firstPane) {
              // The server-reported windowId / ref identifies the window for every mux kind; no tmux ref is synthesised from the target.
              const termRef: TerminalRef = firstWin.windowId !== null
                ? { kind: 'windowId', serverName: awServer, windowId: firstWin.windowId, pane: firstPane.index }
                : { kind: 'ref', serverName: awServer, ref: firstWin.ref, pane: firstPane.index };
              onConnect?.(termRef, numericProjectId);
            }
          }
        }
      } else if (awMode === 'existing') {
        const option = windowTargetSelectOptions(awSessionData[awServer] || []).find((o) => o.value === awTarget);
        if (!option) throw new Error(`window ${awTarget} is not listed on ${awServer}`);
        const muxKind = option.kind;
        // tmux keeps its target-derived ref; another mux uses the ref the server reported for the picked window.
        const existingRef = muxKind === 'tmux'
          ? resolveWindowRegistrationRef({ muxKind, target: awTarget, sessions: awSessionData[awServer] })
          : option.ref;
        if (!existingRef) throw new Error(`window ref is not resolved for ${awTarget}`);
        const registered = await api<{ ok: boolean; id: number }>(`/projects/${effectiveProjectId}/windows`, { method: 'POST', body: JSON.stringify({ server_name: awServer, tmux_target: awTarget, ref: existingRef, label: awLabel.trim() }) });
        if (awTaskId != null) {
          try {
            const reg = taskWindowRegistration({ muxKind, target: awTarget, ref: existingRef });
            if (!reg) throw new Error(`window ref is not resolved for ${awTarget}`);
            await onTaskWindowAdded?.(awTaskId, awServer, reg.target, awLabel.trim(), true, reg.ref ? { ref: reg.ref } : undefined);
          } catch (err) {
            failTaskWindow(err);
            return;
          }
        } else {
          onConnect?.(registeredWindowTerminalRef(awServer, registered.id), numericProjectId);
        }
      } else {
        if (awAgent !== 'none') {
          const plannedAgentCmd = buildAgentCommand(awAgent, awAgentModel, agentPresets[awAgent]?.command || '', awNewCommand);
          if (!plannedAgentCmd.trim()) {
            showToast(t('addWindow.agentCommandUnavailable'));
            return;
          }
        }
        const sessionName = awNewSession.trim();
        const beforeSessions = awSessionData[awServer] || [];
        // Only a session of the mux the window is created in counts (a same-named session of the other mux does not).
        const sessionExists = beforeSessions.some((s) => s.name === sessionName && sessionKindOf(s) === newKind);
        const windowName = awNewWindowName.trim() || undefined;
        const serverPath = `/servers/${encodeURIComponent(awServer)}/mux/workspaces`;
        const res = await api<MuxCreateResponse | { error: string }>(
          sessionExists ? `${serverPath}/${encodeURIComponent(sessionName)}/windows` : serverPath,
          {
            method: 'POST',
            body: JSON.stringify(sessionExists
              ? { name: windowName, kind: newKind, force }
              : { name: sessionName, windowName, kind: newKind, force }),
          },
        );
        if (isInsufficientResources(res)) {
          setAwResourceWarning({ resources: res.resources, retry: () => { setAwResourceWarning(null); void perform(true); } });
          return;
        }
        if (isWindowExists(res)) { showToast(t('addWindow.windowExistsError')); return; }
        if (isMuxKindUnavailable(res)) {
          showToast(t('addWindow.muxKindUnavailable', { kind: t(`muxKind.${res.kind}`), reason: t(`muxKind.reason.${muxKindReason(res.kind, res.reason)}`) }));
          return;
        }
        const failure = errorMessageOf(res);
        if (failure !== null) { showToast(failure); return; }
        const createdWindow = res as MuxCreateResponse;
        const createdTarget = createdWindow.target;
        const createdRef: string = createdWindow.ref;

        const target = createdTarget;
        const label = awLabel.trim() || awNewWindowName.trim() || '';
        const newRef = createdRef;
        // tmux keeps its target on the registered row; a misao window is identified by its ref alone.
        const windowBody: Record<string, unknown> = { server_name: awServer, ...(newKind === 'tmux' ? { tmux_target: target } : {}), ref: newRef, label };
        if (awAgent !== 'none') {
          windowBody['window_type'] = 'agent';
          windowBody['worker_type'] = awAgent === 'custom' ? 'generic' : awAgent;
          windowBody['worker_model'] = awAgentModel || undefined;
          windowBody['working_directory'] = awWorkDir.trim() || undefined;
        }
        const created = await api<{ ok: boolean; id: number }>(`/projects/${effectiveProjectId}/windows`, { method: 'POST', body: JSON.stringify(windowBody) });
        const extra = awAgent !== 'none'
          ? { windowType: 'agent' as const, workerType: awAgent === 'custom' ? 'generic' : awAgent, workerModel: awAgentModel || undefined, workingDirectory: awWorkDir.trim() || undefined }
          : undefined;
        if (awTaskId != null) {
          await onTaskWindowAdded?.(awTaskId, awServer, target, label, true, { ...extra, ref: newRef });
        } else {
          const termRef: TerminalRef = { kind: 'windowId', serverName: awServer, windowId: created.id, pane: 1 };
          onConnect?.(termRef, numericProjectId);
        }

        if (awWorkDir.trim()) {
          if (created.id) {
            await api(`/windows/${created.id}/panes/1/send-keys`, { method: 'POST', body: JSON.stringify({ keys: [`cd ${awWorkDir.trim()}`, 'Enter'] }) });
          } else {
            await api(`/servers/${encodeURIComponent(awServer)}/mux/windows/${encodeURIComponent(newRef)}/panes/1/send-keys`, { method: 'POST', body: JSON.stringify({ keys: [`cd ${awWorkDir.trim()}`, 'Enter'] }) });
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        if (awAgent !== 'none') {
          const agentCmd = buildAgentCommand(awAgent, awAgentModel, agentPresets[awAgent]?.command || '', awNewCommand);
          if (agentCmd) {
            // ウィンドウ作成後の launch-agent が 409 になった場合はウィンドウ自体は残し、
            // retry では launch-agent のみ force 再送する（ウィンドウを二重作成しない）
            await launchAgent(created.id, agentCmd, force);
          }
        }
      }
      setAddWindowOpen(false);
      closeQuickAddWindow();
      refreshWorkspace();
      refreshSessions?.();
    } finally {
      setAddWindowLoading(false);
    }
  }, [projectId, awEffectiveProjectId, awMode, awServer, awTarget, awLabel, awSelectedSession, awNewSession, awNewWindowName, awNewCommand, awWorkDir, awAgent, awAgentModel, awSessionData, muxKindModel, agentPresets, project, refreshWorkspace, refreshSessions, addWindowLoading, awTaskId, onConnect, onTaskWindowAdded, launchAgent, showToast, t, closeQuickAddWindow]);

  return {
    // State
    addWindowOpen,
    awMode,
    awServer,
    awTarget,
    awLabel,
    awSessionData,
    awOfflineServers,
    awSelectedSession,
    awNewSession,
    awNewWindowName,
    awNewCommand,
    awWorkDir,
    awAgent,
    awAgentModel,
    awWorkerModels,
    addWindowLoading,
    agentPresets,
    agentPresetsLoading: agentDefsLoading,
    agentPresetsError: agentDefsError,
    awEffectiveProjectServers,
    awEffectiveProject,
    awResourceWarning,
    awQuickAddOpen,
    awQuickAddAgent,
    awQuickAddLoading,
    muxKindModel,

    // Setters
    setAddWindowOpen,
    setAwQuickAddOpen,
    setAwMode,
    setAwServer,
    setAwMuxChoice,
    setAwTarget,
    setAwLabel,
    setAwSelectedSession,
    setAwNewSession,
    setAwNewWindowName,
    setAwNewCommand,
    setAwWorkDir,
    setAwAgent,
    setAwAgentModel,
    setAwWorkerModels,
    setAddWindowLoading,
    setAwResourceWarning,

    // Callbacks
    handleAgentChange,
    openAddWindow,
    openQuickAddWindow,
    closeQuickAddWindow,
    loadMissingSessions,
    getWindowTargets,
    handleAddWindow,
  };
}
