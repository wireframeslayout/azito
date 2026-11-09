import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { useOrchestrators } from '../../hooks/useOrchestrators';
import { useRightPanelState } from '../../hooks/useRightPanelState';
import { useToast } from '../../hooks/useToast';
import { paths } from '../../paths';
import { TerminalContainer } from '../TerminalContainer';
import { RightPanel } from '../workspace/RightPanel';
import { RightPanelToggle } from '../workspace/RightPanelToggle';
import { LoadingState } from '../ui';
import { buildOrchestrationTree, type OrchestrationNode } from '../../lib/orchestrationModel';

export interface OrchestrationPageProps { rightPanel?: ReactNode }

export default function OrchestrationPage({ rightPanel }: OrchestrationPageProps): ReactNode {
  const { t } = useTranslation('workspace');
  const { windows, status, refresh } = useOrchestrators();
  const { pathname, state } = useLocation();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [open, setOpen] = useRightPanelState();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const [search, setSearch] = useState('');
  const id = pathname.split('/')[2];
  const selected = windows.find((window) => String(window.id) === id);
  useEffect(() => {
    if (status !== 'ready') return;
    if (!id && windows.length && !state?.missing) navigate(paths.orchestration(windows[0].id), { replace: true });
    else if (id && !selected) {
      showToast(t('orchestration.notFound'));
      navigate(paths.orchestration(), { replace: true, state: { missing: true } });
    }
  }, [status, id, selected, windows, navigate, showToast, t, state]);
  const renderNode = (node: OrchestrationNode, depth: number): ReactNode => {
    const label = node.window.label || node.window.tmuxTarget;
    const matches = (entry: OrchestrationNode): boolean => `${entry.window.label ?? ''} ${entry.window.tmuxTarget} ${entry.window.serverName}`.toLowerCase().includes(search.toLowerCase()) || entry.children.some(matches);
    if (!matches(node)) return null;
    return <div key={node.window.id} role="treeitem" aria-level={depth + 1} aria-selected={selected?.id === node.window.id}>
      <button onClick={() => navigate(paths.orchestration(node.window.id))} style={{ display: 'block', width: '100%', textAlign: 'left', padding: 'var(--space-2)', paddingLeft: `${depth + 1}em`, background: selected?.id === node.window.id ? 'var(--purple-a15)' : 'transparent', color: 'var(--text)', border: 0, cursor: 'pointer' }}>{label} · {node.window.serverName}</button>
      {node.children.length > 0 && <div role="group">{node.children.map((child) => renderNode(child, depth + 1))}</div>}
    </div>;
  };
  if (status === 'loading') return <LoadingState />;
  if (status === 'error') return <div role="alert">{t('orchestration.loadError')} <button onClick={refresh}>{t('orchestration.retry')}</button></div>;
  return <div style={{ display: 'flex', height: '100%', minWidth: 0 }}>
    <aside style={{ width: 260, maxWidth: '45%', overflow: 'auto', background: 'var(--bg-solid)', borderRight: '1px solid var(--border)' }}>
      <h2>{t('orchestration.title')}</h2>
      <input aria-label={t('orchestration.search')} value={search} onChange={(event) => setSearch(event.target.value)} />
      <div role="tree">{buildOrchestrationTree(windows).map((node) => renderNode(node, 0))}</div>
    </aside>
    <main style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      {selected ? <TerminalContainer key={selected.id} serverName={selected.serverName} target={selected.tmuxTarget} terminalRef={{ kind: 'windowId', serverName: selected.serverName, windowId: selected.id, pane: 1 }} registeredWindow={{ id: selected.id }} /> : <p>{t('orchestration.empty')}</p>}
      {!open && <RightPanelToggle open={false} onToggle={() => setOpen(true)} controls="orchestration-right-panel" buttonRef={toggleRef} />}
    </main>
    <RightPanel id="orchestration-right-panel" title={t('orchestration.connected')} open={open} onOpenChange={setOpen} toggleRef={toggleRef}>{rightPanel}</RightPanel>
  </div>;
}
