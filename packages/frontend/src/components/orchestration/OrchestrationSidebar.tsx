import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLongPress } from '../../hooks/useLongPress';
import ContextMenu, { useContextMenu } from '../ContextMenu';
import { useWorkspaceCatalog } from '../../hooks/useWorkspaceCatalog';
import { useAgentActivity } from '../../hooks/useAgentActivity';
import { useOrchestrators } from '../../hooks/useOrchestrators';
import { buildOrchestrationTree, orchestratorState, type OrchestrationNode, type OrchestratorState } from '../../lib/orchestrationModel';
import { formatRelativeTime } from '../../utils/time';
import { LoadingState, WindowIdChip } from '../ui';

export interface OrchestrationSidebarProps {
  selectedId?: number;
  onSelect: (id: number) => void;
  onRemove?: (id: number) => void;
}
export function OrchestrationSidebar({ selectedId, onSelect, onRemove }: OrchestrationSidebarProps): ReactNode {
  const { t } = useTranslation('workspace');
  const { windows, status, refresh } = useOrchestrators();
  const { allProjects } = useWorkspaceCatalog();
  const { activityStatus, snapshotStatus, retrySnapshot } = useAgentActivity();
  const [search, setSearch] = useState('');
  const contextMenu = useContextMenu();
  const bindLongPress = useLongPress();
  const menuItems = (id: number) => onRemove ? [{ label: t('orchestration.removeRole'), onClick: () => onRemove(id) }] : [];
  const [closed, setClosed] = useState<Set<number>>(new Set());
  const matches = (node: OrchestrationNode): boolean => `${node.window.label ?? ''} ${node.window.tmuxTarget} ${node.window.serverName}`.toLowerCase().includes(search.toLowerCase()) || node.children.some(matches);
  const renderNode = (node: OrchestrationNode, depth: number): ReactNode => {
    if (!matches(node)) return null;
    const expanded = !closed.has(node.window.id) || !!search;
    return <div key={node.window.id} role="treeitem" aria-level={depth + 1} aria-expanded={node.children.length ? expanded : undefined} aria-selected={selectedId === node.window.id}>
      <div style={{ display: 'flex', paddingLeft: `calc(var(--space-3) * ${depth})` }}>
        {node.children.length > 0 && <button aria-label={expanded ? t('orchestration.collapse') : t('orchestration.expand')} onClick={() => setClosed((previous) => { const next = new Set(previous); if (next.has(node.window.id)) next.delete(node.window.id); else next.add(node.window.id); return next; })}>{expanded ? '−' : '+'}</button>}
        <button data-orchestration-row onContextMenu={(event) => { if (onRemove) contextMenu.show(event, menuItems(node.window.id)); }} {...(onRemove ? bindLongPress((x, y) => contextMenu.showAt(x, y, menuItems(node.window.id))) : {})} onKeyDown={(event) => {
          if (event.key === 'ArrowRight' && node.children.length) {
            event.preventDefault();
            if (expanded) event.currentTarget.closest('[role="treeitem"]')?.querySelector<HTMLButtonElement>(':scope > [role="group"] [data-orchestration-row]')?.focus();
            else setClosed((previous) => { const next = new Set(previous); next.delete(node.window.id); return next; });
          }
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            if (expanded && node.children.length) setClosed((previous) => new Set(previous).add(node.window.id));
            else event.currentTarget.closest('[role="treeitem"]')?.parentElement?.closest('[role="treeitem"]')?.querySelector<HTMLButtonElement>('[data-orchestration-row]')?.focus();
          }
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault();
            const rows = Array.from(event.currentTarget.closest('[role="tree"]')?.querySelectorAll<HTMLButtonElement>('[data-orchestration-row]') ?? []);
            const index = rows.indexOf(event.currentTarget) + (event.key === 'ArrowDown' ? 1 : -1);
            rows[index]?.focus();
          }
        }} onClick={() => onSelect(node.window.id)} style={{ flex: 1, minWidth: 0, textAlign: 'left', padding: 'var(--space-2)', background: selectedId === node.window.id ? 'var(--purple-a15)' : 'transparent', color: 'var(--text)', border: 0, cursor: 'pointer' }}><WindowIdChip id={node.window.id} /> {node.window.label || node.window.tmuxTarget} · {node.window.serverName} · {t(`orchestration.${orchestratorState(node.window, activityStatus(node.window.serverName, node.window.tmuxTarget))}`)} · {t('orchestration.links', { count: node.window.links.total })}{node.window.links.projectIds.map((id) => allProjects.find((project) => project.id === id)?.name).filter(Boolean).map((name) => ` · ${name}`)}{node.window.links.serverNames.filter((name) => name !== node.window.serverName).map((name) => ` · ${name}`)}{node.window.lastInteractionAt && ` · ${formatRelativeTime(node.window.lastInteractionAt)}`}</button>
        {onRemove && <button onClick={() => onRemove(node.window.id)} aria-label={t('orchestration.removeRole')}>×</button>}
      </div>
      {expanded && node.children.length > 0 && <div role="group">{node.children.map((child) => renderNode(child, depth + 1))}</div>}
    </div>;
  };
  if (status === 'loading' || snapshotStatus === 'loading') return <LoadingState />;
  if (snapshotStatus === 'error') return <div role="alert">{t('orchestration.loadError')} <button onClick={retrySnapshot}>{t('orchestration.retry')}</button></div>;
  if (status === 'error') return <div role="alert">{t('orchestration.loadError')} <button onClick={refresh}>{t('orchestration.retry')}</button></div>;
  const tree = buildOrchestrationTree(windows);
  const states: OrchestratorState[] = ['running', 'idle', 'sleeping'];
  return <><input aria-label={t('orchestration.search')} value={search} onChange={(event) => setSearch(event.target.value)} /><div role="tree">{states.map((state) => {
    const nodes = tree.filter((node) => orchestratorState(node.window, activityStatus(node.window.serverName, node.window.tmuxTarget)) === state && matches(node));
    return nodes.length ? <div key={state} role="group" aria-label={t(`orchestration.${state}`)}><h3>{t(`orchestration.${state}`)}</h3>{nodes.map((node) => renderNode(node, 0))}</div> : null;
  })}</div>{contextMenu.menu && <ContextMenu menu={contextMenu.menu} onClose={contextMenu.hide} />}</>;
}
