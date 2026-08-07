import React, { useMemo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { api } from '../../api/client';
import { useAgentDefinitions } from '../../hooks/useAgentDefinitions';
import { WindowPaneTree, AGENT_ICON_MAP, TerminalIcon } from '../ui';
import type { WindowItem } from '../ui';
import { useAgentActivity } from '../../hooks/useAgentActivity';
import { WindowActivityIndicator } from '../ui';
import { buildObjectSections } from '../../lib/workspaceObjects';
import type { BrowserGroupInfo } from '../../hooks/useBrowserGroups';
import type { Project, Session, Window } from '../../pages/workspace/types';
import { stripPaneSuffix } from '../../utils/tmuxTarget';
import ObjectSection from './objects/ObjectSection';
import BrowserSection from './objects/BrowserSection';

const COLLAPSE_STORAGE_KEY = 'workspace-objects-collapsed';

type SectionId = 'windows' | 'operations' | 'browsers';

interface CollapseState {
  windows: boolean;
  operations: boolean;
  browsers: boolean;
}

function loadCollapseState(): CollapseState {
  try {
    const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY);
    if (raw) return { windows: false, operations: false, browsers: false, ...JSON.parse(raw) };
  } catch { /* best-effort */ }
  return { windows: false, operations: false, browsers: false };
}

function saveCollapseState(state: CollapseState): void {
  try {
    localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(state));
  } catch { /* best-effort */ }
}

function useObjectSectionCollapse() {
  const [state, setState] = useState<CollapseState>(loadCollapseState);
  const toggle = useCallback((id: SectionId) => {
    setState((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      saveCollapseState(next);
      return next;
    });
  }, []);
  return { collapsed: state, toggle };
}

interface ObjectsSidebarProps {
  project: Project;
  sessionData: Record<string, Session[]>;
  activeTabId: string | null;
  mobile: boolean;
  projectServers: { serverName: string; workingDirectory?: string }[];
  connectPane: (serverName: string, target: string) => void;
  showWindowContextMenu: (e: React.MouseEvent, w: Window, extra?: { online: boolean; windowName?: string; paneTarget?: string; paneTitle?: string }) => void;
  onOpenAddWindow: () => void;
  onOpenQuickAdd: (serverName: string, agentType: QuickAddAgent) => void;
  onCloseMobileSidebar: () => void;
  respawningWindowIds?: Set<number>;
  taskWindows?: Array<{ serverName: string; tmuxTarget: string; taskId: number }>;
  browserGroups: Record<string, BrowserGroupInfo[]>;
  browserErrors: Record<string, string>;
  refreshBrowserGroups: () => void;
  openBrowser: (serverName: string, groupId?: string) => void;
  openTask: (taskId: number, title: string) => void;
  onOpenTaskWindow?: (taskId: number, taskTitle: string, terminal: { serverName: string; target: string }) => void;
}

type QuickAddAgent = 'claude' | 'codex' | 'terminal';

interface QuickAddButton {
  type: QuickAddAgent;
  label: string;
}

const QUICK_ADD_TYPES: QuickAddAgent[] = ['claude', 'codex', 'terminal'];

export default function ObjectsSidebar({
  project,
  sessionData,
  activeTabId,
  mobile,
  projectServers,
  connectPane,
  showWindowContextMenu,
  onOpenAddWindow,
  onOpenQuickAdd,
  onCloseMobileSidebar,
  respawningWindowIds,
  taskWindows,
  browserGroups,
  browserErrors,
  refreshBrowserGroups,
  openBrowser,
  openTask,
  onOpenTaskWindow,
}: ObjectsSidebarProps) {
  const { t } = useTranslation(['workspace', 'tasks']);
  const { collapsed, toggle } = useObjectSectionCollapse();

  const checkActive = useCallback((serverName: string, target: string) =>
    activeTabId === `terminal:${serverName}/${target}`,
  [activeTabId]);

  const projectServerNames = useMemo(
    () => projectServers.map((ps) => ps.serverName),
    [projectServers],
  );

  const sections = useMemo(
    () => buildObjectSections(project.windows, taskWindows ?? [], browserGroups, projectServerNames),
    [project.windows, taskWindows, browserGroups, projectServerNames],
  );

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
  })), [agentByType, t]);

  // Window section: group by server
  const serverGroups = useMemo(() => {
    const map = new Map<string, Window[]>();
    for (const w of sections.windows) {
      const list = map.get(w.serverName) || [];
      list.push(w);
      map.set(w.serverName, list);
    }
    return map;
  }, [sections.windows]);

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

  const handleOpenBrowser = useCallback((serverName: string, groupId?: string) => {
    openBrowser(serverName, groupId);
    if (mobile) onCloseMobileSidebar();
  }, [openBrowser, mobile, onCloseMobileSidebar]);

  const handleOpenTask = useCallback((taskId: number) => {
    openTask(taskId, t('tasks:detail.taskRef', { id: taskId }));
    if (mobile) onCloseMobileSidebar();
  }, [openTask, mobile, onCloseMobileSidebar, t]);

  // serverName + pane-suffix-stripped target -> operation window (for routing clicks to the owning task panel)
  const operationWindowByKey = useMemo(() => {
    const map = new Map<string, Window>();
    for (const w of sections.operationWindows) {
      map.set(`${w.serverName}/${stripPaneSuffix(w.tmuxTarget)}`, w);
    }
    return map;
  }, [sections.operationWindows]);

  const handleOperationPaneClick = useCallback((serverName: string, target: string) => {
    const w = operationWindowByKey.get(`${serverName}/${stripPaneSuffix(target)}`);
    if (w?.taskId != null && onOpenTaskWindow) {
      onOpenTaskWindow(w.taskId, t('tasks:detail.taskRef', { id: w.taskId }), { serverName: w.serverName, target: w.tmuxTarget });
      if (mobile) onCloseMobileSidebar();
      return;
    }
    handlePaneClick(serverName, target);
  }, [operationWindowByKey, onOpenTaskWindow, t, mobile, onCloseMobileSidebar, handlePaneClick]);

  const renderOperationExtra = useCallback((w: WindowItem) => {
    const status = windowIndicator(w.serverName, w.tmuxTarget);
    const fe = status === 'finished' ? finishedEntries.find((e) => e.serverName === w.serverName && e.target === w.tmuxTarget) : undefined;
    return (
      <>
        {status && <WindowActivityIndicator status={status} finishedAt={fe?.finishedAt} />}
        {w.taskId != null && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleOpenTask(w.taskId!); }}
            style={{
              fontSize: 'var(--font-2xs)',
              color: 'var(--text-dim)',
              background: 'var(--bg)',
              borderRadius: 'var(--radius-sm)',
              padding: '1px 5px',
              flexShrink: 0,
              border: 'none',
              cursor: 'pointer',
            }}
            className="icon-btn"
          >
            #{w.taskId}
          </button>
        )}
      </>
    );
  }, [windowIndicator, finishedEntries, handleOpenTask]);

  const browserSectionAction = useMemo(() => {
    if (projectServerNames.length === 0) return null;
    const handleClick = () => {
      if (projectServerNames.length === 1) {
        handleOpenBrowser(projectServerNames[0]);
      }
    };
    if (projectServerNames.length === 1) {
      return (
        <button
          onClick={handleClick}
          title={t('objects.openBrowser')}
          aria-label={t('objects.openBrowser')}
          className="icon-btn"
          style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', padding: '3px 6px', display: 'flex', alignItems: 'center' }}
        >
          <Icon name="plus" size={16} />
        </button>
      );
    }
    return (
      <div style={{ position: 'relative' }}>
        <ServerSelectMenu serverNames={projectServerNames} onSelect={(name) => handleOpenBrowser(name)}>
          <button
            title={t('objects.openBrowser')}
            aria-label={t('objects.openBrowser')}
            className="icon-btn"
            style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', padding: '3px 6px', display: 'flex', alignItems: 'center' }}
          >
            <Icon name="plus" size={16} />
          </button>
        </ServerSelectMenu>
      </div>
    );
  }, [projectServerNames, handleOpenBrowser, t]);

  const emptyMessage = (key: string) => (
    <div style={{ padding: '6px 20px', fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>{t(key)}</div>
  );

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
      <div style={{ marginBottom: 4 }}>
        <div style={{ fontSize: 'var(--font-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-dim)', padding: '12px 12px 4px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>{t('objects.title')} <span style={{ fontWeight: 400, fontSize: 'var(--font-2xs)', background: 'var(--bg)', padding: '1px 6px', borderRadius: 'var(--radius-md)' }}>{sections.totalCount}</span></span>
          <button onClick={() => onOpenAddWindow()} title={t('windows.addWindow')} className="icon-btn" style={{ border: 'none', color: 'var(--text-dim)', cursor: 'pointer', padding: '3px 6px', display: 'flex', alignItems: 'center' }}><Icon name="plus" size={16} /></button>
        </div>

        {sections.totalCount === 0 ? (
          <div style={{ padding: '12px 20px', fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>{t('objects.noObjects')}</div>
        ) : (
          <>
            <ObjectSection
              id="windows"
              label={t('objects.sectionWindows')}
              count={sections.windows.length}
              collapsed={collapsed.windows}
              onToggleCollapse={() => toggle('windows')}
              action={
                <button onClick={() => onOpenAddWindow()} title={t('windows.addWindow')} className="icon-btn" style={{ background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', padding: '3px 6px', display: 'flex', alignItems: 'center' }}><Icon name="plus" size={16} /></button>
              }
              empty={emptyMessage('windows.noWindows')}
            >
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
                    onOpenQuickAdd={onOpenQuickAdd}
                    extra={renderActivityExtra}
                    activityClassName={renderActivityClassName}
                    respawningWindowIds={respawningWindowIds}
                  />
                );
              })}
            </ObjectSection>

            <ObjectSection
              id="operations"
              label={t('objects.sectionOperations')}
              count={sections.operationWindows.length}
              collapsed={collapsed.operations}
              onToggleCollapse={() => toggle('operations')}
              empty={emptyMessage('objects.noOperations')}
            >
              <WindowPaneTree
                windows={sections.operationWindows}
                sessionData={sessionData}
                isActive={checkActive}
                onPaneClick={handleOperationPaneClick}
                onContextMenu={showWindowContextMenu as (e: React.MouseEvent, w: WindowItem, extra?: { online: boolean; windowName?: string; paneTarget?: string; paneTitle?: string }) => void}
                extra={renderOperationExtra}
                activityClassName={renderActivityClassName}
                respawningWindowIds={respawningWindowIds}
              />
            </ObjectSection>

            <ObjectSection
              id="browsers"
              label={t('objects.sectionBrowsers')}
              count={sections.browsers.length + Object.keys(browserErrors).length}
              collapsed={collapsed.browsers}
              onToggleCollapse={() => toggle('browsers')}
              action={browserSectionAction}
              empty={emptyMessage('objects.noBrowsers')}
            >
              <BrowserSection
                browsers={sections.browsers}
                errors={browserErrors}
                activeTabId={activeTabId}
                openBrowser={handleOpenBrowser}
                onRefresh={refreshBrowserGroups}
              />
            </ObjectSection>
          </>
        )}
      </div>
    </div>
  );
}

// --- ServerGroup (unchanged from WindowsSidebar) ---

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
  onOpenQuickAdd: (serverName: string, agentType: QuickAddAgent) => void;
  extra?: (w: WindowItem) => React.ReactNode;
  activityClassName?: (w: WindowItem) => string | undefined;
  respawningWindowIds?: Set<number>;
}

function ServerGroup({
  serverName, windows, sessionData, isActive,
  quickAddButtons, quickAddIcons, agentDefsError,
  onPaneClick, onContextMenu,
  onOpenQuickAdd, extra, activityClassName,
  respawningWindowIds,
}: ServerGroupProps) {
  const { t } = useTranslation('workspace');
  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '8px 12px 4px', gap: 4 }}>
        <span style={{ flex: 1, fontSize: 'var(--font-xs)', fontWeight: 600, color: 'var(--text-dim)', letterSpacing: 0.3 }}>{serverName}</span>
        {quickAddButtons.map((btn) => {
          const IconComp = quickAddIcons[btn.type];
          const isDisabled = btn.type !== 'terminal' && !!agentDefsError;
          return (
            <button
              key={btn.type}
              onClick={() => onOpenQuickAdd(serverName, btn.type)}
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
              <IconComp size={14} />
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

// --- ServerSelectMenu (simple dropdown for multiple servers) ---

function ServerSelectMenu({ serverNames, onSelect, children }: {
  serverNames: string[];
  onSelect: (name: string) => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation('workspace');

  return (
    <div style={{ position: 'relative', display: 'inline-flex' }}>
      <div onClick={() => setOpen((prev) => !prev)}>
        {children}
      </div>
      {open && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 100 }}
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            style={{
              position: 'absolute',
              top: '100%',
              right: 0,
              zIndex: 101,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-md)',
              padding: '4px 0',
              minWidth: 140,
              boxShadow: 'var(--shadow-lg)',
            }}
          >
            <div style={{ padding: '4px 12px', fontSize: 'var(--font-xs)', color: 'var(--text-dim)', fontWeight: 600 }}>
              {t('objects.selectServer')}
            </div>
            {serverNames.map((name) => (
              <button
                key={name}
                role="menuitem"
                onClick={() => { onSelect(name); setOpen(false); }}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '6px 12px',
                  background: 'none',
                  border: 'none',
                  color: 'var(--text)',
                  fontSize: 'var(--font-sm)',
                  cursor: 'pointer',
                  borderRadius: 0,
                }}
                className="row-hover"
              >
                {name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
