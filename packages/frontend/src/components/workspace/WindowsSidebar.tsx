import React, { useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { api } from '../../api/client';
import { useAgentDefinitions } from '../../hooks/useAgentDefinitions';
import { WindowPaneTree, AGENT_ICON_MAP, TerminalIcon } from '../ui';
import type { WindowItem } from '../ui';
import { useAgentActivity } from '../../hooks/useAgentActivity';
import { WindowActivityIndicator } from '../ui';
import { buildWindowTaskMap, lookupWindowTask } from '../../lib/windowTask';
import type { Project, Session, Window } from '../../pages/workspace/types';

interface WindowsSidebarProps {
  project: Project;
  sessionData: Record<string, Session[]>;
  activeTabId: string | null;
  mobile: boolean;

  projectServers: { serverName: string; workingDirectory?: string }[];
  connectPane: (serverName: string, target: string) => void;
  showWindowContextMenu: (e: React.MouseEvent, w: Window, extra?: { online: boolean; windowName?: string; paneTarget?: string; paneTitle?: string }) => void;
  onOpenAddWindow: () => void;
  onCloseMobileSidebar: () => void;
  respawningWindowIds?: Set<number>;
  taskWindows?: Array<{ serverName: string; tmuxTarget: string; taskId: number }>;
}

type QuickAddAgent = 'claude' | 'codex' | 'terminal';

interface QuickAddButton {
  type: QuickAddAgent;
  label: string;
}

const QUICK_ADD_TYPES: QuickAddAgent[] = ['claude', 'codex', 'terminal'];

export default function WindowsSidebar({
  project,
  sessionData,
  activeTabId,
  mobile,
  projectServers,
  connectPane,
  showWindowContextMenu,
  onOpenAddWindow,
  onCloseMobileSidebar,
  respawningWindowIds,
  taskWindows,
}: WindowsSidebarProps) {
  const { t } = useTranslation('workspace');
  const checkActive = useCallback((serverName: string, target: string) =>
    activeTabId === `terminal:${serverName}/${target}`,
  [activeTabId]);
  // level is intentionally ignored: activeTabId comparison is already an exact
  // target match at both 'window' and 'pane' levels.

  const windowTaskMap = useMemo(() => buildWindowTaskMap(taskWindows ?? []), [taskWindows]);
  const resolvedWindows = useMemo(() => project.windows.map((w) => (
    w.taskId != null ? w : { ...w, taskId: lookupWindowTask(windowTaskMap, w.serverName, w.tmuxTarget) }
  )), [project.windows, windowTaskMap]);

  const { agents: agentDefs, error: agentDefsError } = useAgentDefinitions('worker');
  const { windowIndicator, finishedEntries } = useAgentActivity();

  const renderActivityExtra = useCallback((w: WindowItem) => {
    const status = windowIndicator(w.serverName, w.tmuxTarget);
    if (!status) return null;
    const fe = status === 'finished' ? finishedEntries.find((e) => e.serverName === w.serverName && e.target === w.tmuxTarget) : undefined;
    return <WindowActivityIndicator status={status} finishedAt={fe?.finishedAt} />;
  }, [windowIndicator, finishedEntries]);
  const renderActivityClassName = useCallback((w: WindowItem) => {
    const status = windowIndicator(w.serverName, w.tmuxTarget);
    if (status === 'blocked') return 'aw-row-blocked';
    if (status === 'working') return 'aw-row-working';
    return undefined;
  }, [windowIndicator]);
  const agentByType = useMemo(() => new Map(agentDefs.map((d) => [d.type, d])), [agentDefs]);

  const quickAddIcons: Record<QuickAddAgent, React.FC<{ size?: number }>> = useMemo(() => ({
    claude: AGENT_ICON_MAP['claude'] ?? TerminalIcon,
    codex: AGENT_ICON_MAP['codex'] ?? TerminalIcon,
    terminal: TerminalIcon,
  }), []);

  const quickAddButtons: QuickAddButton[] = useMemo(() => QUICK_ADD_TYPES.map((type) => ({
    type,
    label: type === 'terminal' ? t('common:labels.terminal') : (agentByType.get(type)?.label ?? type),
  })), [agentByType]);

  const serverGroups = useMemo(() => {
    const map = new Map<string, Window[]>();
    for (const w of resolvedWindows) {
      const list = map.get(w.serverName) || [];
      list.push(w);
      map.set(w.serverName, list);
    }
    return map;
  }, [resolvedWindows]);

  const sortedServerNames = useMemo(() => {
    const psOrder = projectServers.map((ps) => ps.serverName);
    const allNames = [...serverGroups.keys()];
    const ordered = psOrder.filter((n) => allNames.includes(n));
    const remaining = allNames.filter((n) => !ordered.includes(n));
    return [...ordered, ...remaining];
  }, [projectServers, serverGroups]);

  const handlePaneClick = useCallback(async (serverName: string, target: string) => {
    if (mobile) {
      try {
        await api(`/servers/${serverName}/panes/${encodeURIComponent(target)}/zoom`, { method: 'POST' });
      } catch { /* best-effort */ }
    }
    connectPane(serverName, target);
    if (mobile) onCloseMobileSidebar();
  }, [mobile, connectPane, onCloseMobileSidebar]);

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
      <div style={{ marginBottom: 4 }}>
        <div style={{ fontSize: 'var(--font-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-dim)', padding: '12px 12px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>{t('windows.title')} <span style={{ fontWeight: 400, fontSize: 'var(--font-2xs)', background: 'var(--bg)', padding: '1px 6px', borderRadius: 'var(--radius-md)' }}>{resolvedWindows.length}</span></span>
          <button onClick={() => onOpenAddWindow()} title={t('windows.addWindow')} className="icon-btn" style={{ border: 'none', color: 'var(--text-dim)', cursor: 'pointer', padding: '3px 6px', display: 'flex', alignItems: 'center' }}><Icon name="plus" size={16} /></button>
        </div>

        {sortedServerNames.map((serverName) => {
          const windows = serverGroups.get(serverName) || [];
          return (
            <ServerGroup
              key={serverName}
              serverName={serverName}
              windows={windows}
              sessionData={sessionData}
              isActive={checkActive}
              quickAddButtons={quickAddButtons}
              quickAddIcons={quickAddIcons}
              agentDefsError={agentDefsError}
              onPaneClick={handlePaneClick}
              onContextMenu={showWindowContextMenu}
              onOpenAddWindow={onOpenAddWindow}
              extra={renderActivityExtra}
              activityClassName={renderActivityClassName}
              respawningWindowIds={respawningWindowIds}
            />
          );
        })}

        {project.windows.length === 0 && (
          <div style={{ padding: '12px 20px', fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>{t('windows.noWindows')}</div>
        )}
      </div>
    </div>
  );
}

interface ServerGroupProps {
  serverName: string;
  windows: Window[];
  sessionData: Record<string, Session[]>;
  isActive: (serverName: string, target: string, level: 'window' | 'pane') => boolean;
  quickAddButtons: QuickAddButton[];
  quickAddIcons: Record<QuickAddAgent, React.FC<{ size?: number }>>;
  agentDefsError?: string | null;
  onPaneClick: (serverName: string, target: string) => void;
  onContextMenu: (e: React.MouseEvent, w: Window, extra?: { online: boolean; windowName?: string; paneTarget?: string; paneTitle?: string }) => void;
  onOpenAddWindow: () => void;
  extra?: (w: WindowItem) => React.ReactNode;
  activityClassName?: (w: WindowItem) => string | undefined;
  respawningWindowIds?: Set<number>;
}

function ServerGroup({
  serverName, windows, sessionData, isActive,
  quickAddButtons, quickAddIcons, agentDefsError,
  onPaneClick, onContextMenu,
  onOpenAddWindow, extra, activityClassName,
  respawningWindowIds,
}: ServerGroupProps) {
  const { t } = useTranslation('workspace');
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '8px 12px 4px', gap: 4 }}>
        <span style={{ flex: 1, fontSize: 'var(--font-xs)', fontWeight: 600, color: 'var(--text-dim)', letterSpacing: 0.3 }}>{serverName}</span>
        {quickAddButtons.map((btn) => {
          const Icon = quickAddIcons[btn.type];
          const isDisabled = btn.type !== 'terminal' && !!agentDefsError;
          return (
            <button
              key={btn.type}
              onClick={() => onOpenAddWindow()}
              disabled={isDisabled}
              title={isDisabled ? t('windows.failedLoadAgents', { error: agentDefsError }) : t('windows.addAgent', { label: btn.label })}
              aria-label={t('windows.addAgentToServer', { label: btn.label, serverName })}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--text-dim)',
                cursor: isDisabled ? 'not-allowed' : 'pointer',
                opacity: isDisabled ? 0.5 : 1,
                padding: '3px 4px',
                borderRadius: 'var(--radius-sm)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon size={14} />
            </button>
          );
        })}
      </div>

      <WindowPaneTree
        windows={windows}
        sessionData={sessionData}
        isActive={isActive}
        onPaneClick={onPaneClick}
        onContextMenu={onContextMenu as (e: React.MouseEvent, w: WindowItem, extra?: { online: boolean; windowName?: string; paneTarget?: string; paneTitle?: string }) => void}
        extra={extra}
        activityClassName={activityClassName}
        respawningWindowIds={respawningWindowIds}
      />
    </div>
  );
}


