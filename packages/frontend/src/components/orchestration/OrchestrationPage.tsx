import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { apiWithStatus } from '../../api/client';
import { useAgentActivity } from '../../hooks/useAgentActivity';
import { orchestratorState, buildOrchestrationTree } from '../../lib/orchestrationModel';
import { useOrchestrators } from '../../hooks/useOrchestrators';
import { useRightPanelState } from '../../hooks/useRightPanelState';
import { useToast } from '../../hooks/useToast';
import { paths } from '../../paths';
import { TerminalContainer } from '../TerminalContainer';
import { RightPanel } from '../workspace/RightPanel';
import { RightPanelToggle } from '../workspace/RightPanelToggle';
import { LoadingState } from '../ui';
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
  const [open, setOpen] = useRightPanelState();
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
  const removeRole = async (windowId: number): Promise<void> => {
    try {
      const response = await apiWithStatus(`/windows/${windowId}/role`, { method: 'PUT', body: JSON.stringify({ role: null }) });
      if (response.status !== 200) throw new Error('role change failed');
      if (selected?.id === windowId) navigate(paths.orchestration(), { replace: true, state: { missing: true } });
      refresh();
      showToast(t('orchestration.restored'), [{ label: t('orchestration.undo'), onClick: () => { void restoreRole(windowId); } }]);
    } catch { showToast(t('orchestration.roleError')); }
  };
  const restoreRole = async (windowId: number): Promise<void> => {
    try {
      const response = await apiWithStatus(`/windows/${windowId}/role`, { method: 'PUT', body: JSON.stringify({ role: 'orchestrator' }) });
      if (response.status !== 200) throw new Error('role change failed');
      refresh();
      showToast(t('orchestration.moved'), [{ label: t('orchestration.open'), onClick: () => navigate(paths.orchestration(windowId)) }]);
    } catch { showToast(t('orchestration.roleError')); }
  };
  if (status === 'loading') return <LoadingState />;
  if (status === 'error') return <div role="alert">{t('orchestration.loadError')} <button onClick={refresh}>{t('orchestration.retry')}</button></div>;
  return <div style={{ display: 'flex', height: '100%', minWidth: 0 }}>
    <aside style={{ width: 260, maxWidth: '45%', overflow: 'auto', background: 'var(--bg-solid)', borderRight: '1px solid var(--border)' }}>
      <h2>{t('orchestration.title')}</h2>
      <OrchestrationSidebar selectedId={selected?.id} onSelect={(id) => navigate(paths.orchestration(id))} onRemove={(id) => { void removeRole(id); }} />
    </aside>
    <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      {selected ? <TerminalContainer key={selected.id} serverName={selected.serverName} target={selected.tmuxTarget} terminalRef={{ kind: 'windowId', serverName: selected.serverName, windowId: selected.id, pane: 1 }} registeredWindow={{ id: selected.id }} /> : <p>{t('orchestration.empty')}</p>}
      <OrchestrationCreate showButton={windows.length === 0} />
      {!open && <RightPanelToggle open={false} onToggle={() => setOpen(true)} controls="orchestration-right-panel" buttonRef={toggleRef} />}
    </main>
    <RightPanel id="orchestration-right-panel" title={t('orchestration.connected')} open={open} onOpenChange={setOpen} toggleRef={toggleRef}>{rightPanel}</RightPanel>
  </div>;
}
