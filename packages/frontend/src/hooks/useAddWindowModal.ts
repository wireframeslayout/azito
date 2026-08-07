import { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import type { Project, Server, Session } from '../pages/workspace/types';
import type { ResourceStatus } from '../components/ResourceWarningDialog';
import { useAgentDefinitions } from './useAgentDefinitions';
import { useToast } from './useToast';

/** 409 insufficient_resources レスポンス（api() はステータスを返さないため body のマーカーで判定する） */
export function isInsufficientResources(res: unknown): res is { error: string; resources: ResourceStatus } {
  return typeof res === 'object' && res !== null
    && (res as Record<string, unknown>)['error'] === 'insufficient_resources';
}

export type AgentPreset = { command: string; label: string };

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
  if (model) cmd += ` --model ${model}`;
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
  onConnect?: (serverName: string, target: string, projectId?: number) => void,
  onTaskWindowAdded?: (taskId: number, serverName: string, tmuxTarget: string, label: string, activate: boolean, extra?: TaskWindowExtra) => Promise<void>,
) {
  const [addWindowOpen, setAddWindowOpen] = useState(false);
  const [awMode, setAwMode] = useState<'existing' | 'session' | 'new'>('existing');
  const [awServer, setAwServer] = useState('');
  const [awTarget, setAwTarget] = useState('');
  const [awLabel, setAwLabel] = useState('');
  const [awSessionData, setAwSessionData] = useState<Record<string, Session[]>>({});
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

  const { t } = useTranslation('workspace');
  const { agents: agentDefs, loading: agentDefsLoading, error: agentDefsError } = useAgentDefinitions('worker');
  const { showToast } = useToast();

  const agentPresets = useMemo<Record<string, AgentPreset>>(() => {
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
  }, [agentDefs, t]);

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
    const effectiveProjectServers = overrideProject?.projectServers ?? projectServers;
    const effectiveProject = overrideProject?.project ?? project;
    setAwEffectiveProjectId(overrideProject?.projectId);
    setAwEffectiveProjectServers(overrideProject?.projectServers);
    setAwEffectiveProject(overrideProject?.project ?? undefined);
    const availableServers = effectiveProjectServers.length > 0
      ? servers.filter((s) => effectiveProjectServers.some((ps) => ps.serverName === s.name))
      : servers;
    const data: Record<string, Session[]> = {};
    for (const srv of availableServers) {
      try { const s = await api<Session[]>(`/servers/${srv.name}/sessions`); if (Array.isArray(s)) data[srv.name] = s; } catch {}
    }
    setAwSessionData(data);
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
  }, [servers, projectServers, project]);

  /**
   * ServerGroup のクイック追加アイコン（claude/codex/terminal）用。サーバー・エージェント種別は
   * 呼び出し時点で確定しているため、モデル選択と作業ディレクトリだけを入力させる最小限のモーダルを開く。
   * 送信は handleAddWindow の 'new' モードをそのまま使う（同じ API・同じパラメータ組み立て）。
   */
  const openQuickAddWindow = useCallback(async (serverName: string, agentType: QuickAddAgent) => {
    const data: Record<string, Session[]> = {};
    try { const s = await api<Session[]>(`/servers/${serverName}/sessions`); if (Array.isArray(s)) data[serverName] = s; } catch {}
    setAwSessionData(data);
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
    if (agent === 'none') {
      setAwWorkerModels([]);
    } else {
      try {
        const models = await api<{ id: string; label: string }[]>(`/workers/models/${agent}`);
        setAwWorkerModels(Array.isArray(models) ? models : []);
      } catch {
        setAwWorkerModels([]);
      }
    }
    setAwQuickAddOpen(true);
  }, [projectServers, project]);

  const getWindowTargets = useCallback((): { value: string; label: string }[] => {
    const sessions = awSessionData[awServer] || [];
    const targets: { value: string; label: string }[] = [];
    for (const s of sessions) {
      for (const w of s.windows) {
        targets.push({ value: `${s.name}:${w.name}`, label: `${s.name} / ${w.name} (${w.panes.length} panes)` });
      }
    }
    return targets;
  }, [awSessionData, awServer]);

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
    try {
      if (awMode === 'session') {
        await api(`/projects/${effectiveProjectId}/windows/session`, { method: 'POST', body: JSON.stringify({ server_name: awServer, session: awSelectedSession }) });
        const sess = (awSessionData[awServer] || []).find((s) => s.name === awSelectedSession);
        if (sess && sess.windows.length > 0) {
          if (awTaskId != null) {
            for (const [index, w] of sess.windows.entries()) {
              await onTaskWindowAdded?.(awTaskId, awServer, `${awSelectedSession}:${w.name}`, w.name, index === 0);
            }
          } else {
            const firstWin = sess.windows[0];
            const firstPane = firstWin.panes[0];
            if (firstPane) onConnect?.(awServer, `${awSelectedSession}:${firstWin.name}.${firstPane.index}`, numericProjectId);
          }
        }
      } else if (awMode === 'existing') {
        await api(`/projects/${effectiveProjectId}/windows`, { method: 'POST', body: JSON.stringify({ server_name: awServer, tmux_target: awTarget, label: awLabel.trim() }) });
        if (awTaskId != null) {
          await onTaskWindowAdded?.(awTaskId, awServer, awTarget, awLabel.trim(), true);
        } else {
          onConnect?.(awServer, awTarget, numericProjectId);
        }
      } else {
        const sessionName = awNewSession.trim();
        const beforeSessions = awSessionData[awServer] || [];
        const sessionExists = beforeSessions.some((s) => s.name === sessionName);
        let createdWindowName: string;
        if (!sessionExists) {
          const res = await api<{ ok: boolean; windowName: string }>(`/servers/${awServer}/sessions`, {
            method: 'POST',
            body: JSON.stringify({ name: sessionName, command: awNewCommand.trim() || undefined, windowName: awNewWindowName.trim() || undefined, force }),
          });
          if (isInsufficientResources(res)) {
            setAwResourceWarning({ resources: res.resources, retry: () => { setAwResourceWarning(null); void perform(true); } });
            return;
          }
          createdWindowName = res.windowName;
        } else {
          const res = await api<{ ok: boolean; windowName: string }>(`/servers/${awServer}/sessions/${sessionName}/windows`, {
            method: 'POST',
            body: JSON.stringify({ name: awNewWindowName.trim() || undefined, force }),
          });
          if (isInsufficientResources(res)) {
            setAwResourceWarning({ resources: res.resources, retry: () => { setAwResourceWarning(null); void perform(true); } });
            return;
          }
          createdWindowName = res.windowName;
        }

        const target = `${sessionName}:${createdWindowName}`;
        const label = awLabel.trim() || awNewWindowName.trim() || '';
        const windowBody: Record<string, unknown> = { server_name: awServer, tmux_target: target, label };
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
          await onTaskWindowAdded?.(awTaskId, awServer, target, label, true, extra);
        } else {
          onConnect?.(awServer, `${target}.1`, numericProjectId);
        }

        const paneTarget = `${target}.1`;
        if (awWorkDir.trim()) {
          await api(`/servers/${awServer}/panes/${encodeURIComponent(paneTarget)}/send-keys`, { method: 'POST', body: JSON.stringify({ keys: [`cd ${awWorkDir.trim()}`, 'Enter'] }) });
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
      setAwQuickAddOpen(false);
      refreshWorkspace();
      refreshSessions?.();
    } finally {
      setAddWindowLoading(false);
    }
  }, [projectId, awEffectiveProjectId, awMode, awServer, awTarget, awLabel, awSelectedSession, awNewSession, awNewWindowName, awNewCommand, awWorkDir, awAgent, awAgentModel, awSessionData, agentPresets, project, refreshWorkspace, refreshSessions, addWindowLoading, awTaskId, onConnect, onTaskWindowAdded, launchAgent, showToast, t]);

  return {
    // State
    addWindowOpen,
    awMode,
    awServer,
    awTarget,
    awLabel,
    awSessionData,
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

    // Setters
    setAddWindowOpen,
    setAwQuickAddOpen,
    setAwMode,
    setAwServer,
    setAwTarget,
    setAwLabel,
    setAwSessionData,
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
    getWindowTargets,
    handleAddWindow,
  };
}
