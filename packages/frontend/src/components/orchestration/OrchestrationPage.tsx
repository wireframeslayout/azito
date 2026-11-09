import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAgentActivity } from '../../hooks/useAgentActivity';
import { orchestratorState, buildOrchestrationTree } from '../../lib/orchestrationModel';
import { useOrchestrators } from '../../hooks/useOrchestrators';
import { useOrchestratorRole } from '../../hooks/useOrchestratorRole';
import { useRightPanelState } from '../../hooks/useRightPanelState';
import { useToast } from '../../hooks/useToast';
import { paths } from '../../paths';
import { TerminalContainer } from '../TerminalContainer';
import { RightPanel } from '../workspace/RightPanel';
import { RightPanelToggle } from '../workspace/RightPanelToggle';
import { GlassPopover, LoadingState } from '../ui';
import { Icon } from '../ui/Icon';
import { BrailleSpinner } from '../ui/WindowActivityIndicator';
import { OrchestrationCreate } from './OrchestrationCreate';
import { OrchestrationSidebar } from './OrchestrationSidebar';

export interface OrchestrationPageProps { rightPanel?: ReactNode }

export default function OrchestrationPage({ rightPanel }: OrchestrationPageProps): ReactNode {
  const { t } = useTranslation('workspace');
  const { windows, status, refresh } = useOrchestrators();
  const { activityStatus, snapshotStatus } = useAgentActivity();
  const { pathname, state } = useLocation();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const changeRole = useOrchestratorRole();
  const [open, setOpen] = useRightPanelState();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const id = pathname.split('/')[2];
  const selected = windows.find((window) => String(window.id) === id);
  useEffect(() => {
    if (status !== 'ready') return;
    if (!id && windows.length && !state?.missing && snapshotStatus === 'ready') {
      const roots = buildOrchestrationTree(windows);
      const order = { running: 0, idle: 1, sleeping: 2 };
      roots.sort((a, b) => order[orchestratorState(a.window, activityStatus(a.window.serverName, a.window.tmuxTarget))] - order[orchestratorState(b.window, activityStatus(b.window.serverName, b.window.tmuxTarget))]);
      navigate(paths.orchestration(roots[0].window.id), { replace: true });
    }
    else if (id && !selected) {
      showToast(t('orchestration.notFound'));
      navigate(paths.orchestration(), { replace: true, state: { missing: true } });
    }
  }, [status, id, selected, windows, navigate, showToast, t, state, snapshotStatus, activityStatus]);
  if (status === 'loading') return <LoadingState />;
  if (status === 'error') return <div role="alert">{t('orchestration.loadError')} <button onClick={refresh}>{t('orchestration.retry')}</button></div>;
  return <div style={{ display: 'flex', height: '100%', minWidth: 0 }}>
    <aside style={{ width: sidebarCollapsed ? 'calc(var(--space-6) * 2)' : 260, maxWidth: '45%', overflow: 'auto', background: 'var(--bg-solid)', borderRight: '1px solid var(--border)' }}>
      <button aria-label={sidebarCollapsed ? t('orchestration.showSidebar') : t('orchestration.hideSidebar')} onClick={() => { setSidebarCollapsed(!sidebarCollapsed); setListOpen(false); }}><Icon name={sidebarCollapsed ? 'panel-left-open' : 'panel-left-close'} size={20} /></button>
      {sidebarCollapsed ? <>
        <button aria-label={t('orchestration.title')} onClick={() => setListOpen((value) => !value)}>{windows.some((window) => orchestratorState(window, activityStatus(window.serverName, window.tmuxTarget)) === 'running') ? <BrailleSpinner /> : <Icon name="operations" size={20} />}</button>
        <GlassPopover open={listOpen} onClose={() => setListOpen(false)} solid ariaLabel={t('orchestration.title')} items={windows.map((window) => ({ key: String(window.id), label: window.label || window.tmuxTarget, selected: selected?.id === window.id, onSelect: () => { navigate(paths.orchestration(window.id)); setListOpen(false); } }))} />
      </> : <><h2>{t('orchestration.title')}</h2><OrchestrationSidebar selectedId={selected?.id} onSelect={(id) => navigate(paths.orchestration(id))} onRemove={(id) => { void changeRole(id, null); }} /></>}
    </aside>
    <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      {selected ? <TerminalContainer key={selected.id} serverName={selected.serverName} target={selected.tmuxTarget} terminalRef={{ kind: 'windowId', serverName: selected.serverName, windowId: selected.id, pane: 1 }} registeredWindow={{ id: selected.id }} /> : <p>{t('orchestration.empty')}</p>}
      <OrchestrationCreate showButton={windows.length === 0} />
      {!open && <RightPanelToggle open={false} onToggle={() => setOpen(true)} controls="orchestration-right-panel" buttonRef={toggleRef} />}
    </main>
    <RightPanel id="orchestration-right-panel" title={t('orchestration.connected')} open={open} onOpenChange={setOpen} toggleRef={toggleRef}>{rightPanel}</RightPanel>
  </div>;
}
