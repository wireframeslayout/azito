import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLongPress } from '../../hooks/useLongPress';
import ContextMenu, { useContextMenu } from '../ContextMenu';
import ConfirmDialog from '../ConfirmDialog';
import ResourceWarningDialog from '../ResourceWarningDialog';
import { useWindowActions } from '../../hooks/useWindowActions';
import { useWorkspaceCatalog } from '../../hooks/useWorkspaceCatalog';
import { useAgentActivity } from '../../hooks/useAgentActivity';
import { useOrchestrators } from '../../hooks/useOrchestrators';
import { buildOrchestrationTree, orchestratorState, type OrchestrationNode, type OrchestratorState } from '../../lib/orchestrationModel';
import { formatRelativeTime } from '../../utils/time';
import { Button, EmptyState, FormInput, IconButton, ListRow, LoadingState, Notice, WindowIdChip } from '../ui';
import { ProjectAvatar } from '../ui/ProjectAvatar';
import WindowActivityIndicator from '../ui/WindowActivityIndicator';
import ObjectSection from '../workspace/objects/ObjectSection';
import { Icon } from '../ui/Icon';

export interface OrchestrationSidebarProps {
  selectedId?: number;
  onSelect: (id: number) => void;
}
export function OrchestrationSidebar({ selectedId, onSelect }: OrchestrationSidebarProps): ReactNode {
  const { t } = useTranslation('workspace');
  const { windows, status, refresh } = useOrchestrators();
  const { allProjects } = useWorkspaceCatalog();
  const { activityStatus, snapshotStatus, retrySnapshot } = useAgentActivity();
  const [search, setSearch] = useState('');
  const contextMenu = useContextMenu();
  const bindLongPress = useLongPress();
  const actions = useWindowActions(undefined, refresh, { showContextMenu: contextMenu.show, showContextMenuAt: contextMenu.showAt, findTaskByTarget: () => null, openTask: () => {}, tabs: [], closeTab: () => {} });
  const [closed, setClosed] = useState<Set<number>>(new Set());
  const [sectionClosed, setSectionClosed] = useState<Set<string>>(new Set());
  const [focusedId, setFocusedId] = useState<number | null>(null);
  const matches = (node: OrchestrationNode): boolean => {
    const projects = node.window.links.projectIds.map((id) => allProjects.find((project) => project.id === id)?.name).filter(Boolean).join(' ');
    return `${node.window.label ?? ''} ${node.window.tmuxTarget} ${node.window.serverName} ${projects}`.toLowerCase().includes(search.toLowerCase()) || node.children.some(matches);
  };
  const tree = buildOrchestrationTree(windows);
  const visible: number[] = [];
  const collect = (node: OrchestrationNode): void => { if (!matches(node)) return; visible.push(node.window.id); if (!closed.has(node.window.id) || search) node.children.forEach(collect); };
  const states: OrchestratorState[] = ['running', 'idle', 'sleeping'];
  for (const state of states) if (!sectionClosed.has(state)) tree.filter((node) => orchestratorState(node.window, activityStatus(node.window.serverName, node.window.tmuxTarget)) === state).forEach(collect);
  const activeFocus = focusedId !== null && visible.includes(focusedId) ? focusedId : selectedId && visible.includes(selectedId) ? selectedId : visible[0];
  const focus = (id: number | undefined): void => { if (id === undefined) return; setFocusedId(id); document.getElementById(`orchestration-row-${id}`)?.focus(); };
  const renderNode = (node: OrchestrationNode, depth: number): ReactNode => {
    if (!matches(node)) return null;
    const window = node.window;
    const expanded = !closed.has(window.id) || !!search;
    const toggle = (): void => setClosed((previous) => { const next = new Set(previous); if (next.has(window.id)) next.delete(window.id); else next.add(window.id); return next; });
    const items = () => actions.getWindowMenuItems(window, { online: !window.sleeping }).filter((item) => item.label !== t('windows.detachFromProject') && (window.originProjectId != null || item.label !== t('orchestration.removeRole')));
    const projects = window.links.projectIds.map((id) => allProjects.find((project) => project.id === id)).filter((project) => project !== undefined);
    return <div key={window.id} id={`orchestration-row-${window.id}`} role="treeitem" aria-label={window.label || window.tmuxTarget} tabIndex={activeFocus === window.id ? 0 : -1} aria-level={depth + 1} aria-expanded={node.children.length ? expanded : undefined} aria-selected={selectedId === window.id} onFocus={(event) => { if (event.target === event.currentTarget) setFocusedId(window.id); }} onClick={(event) => { if ((event.target as HTMLElement).closest('[role=treeitem]') === event.currentTarget && (event.target === event.currentTarget || (event.target as HTMLElement).closest('.list-row'))) onSelect(window.id); }} onContextMenu={(event) => contextMenu.show(event, items())} {...bindLongPress((x, y) => contextMenu.showAt(x, y, items()))} onKeyDown={(event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(window.id); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); focus(visible[visible.indexOf(window.id) + (event.key === 'ArrowDown' ? 1 : -1)]); }
      if (event.key === 'ArrowRight' && node.children.length) { event.preventDefault(); if (!expanded) toggle(); else focus(node.children.find(matches)?.window.id); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); if (expanded && node.children.length) toggle(); else focus(window.parentWindowId ?? undefined); }
    }} style={{ paddingLeft: `calc(var(--space-3) * ${depth})` }}>
      <div style={{ display: 'flex', alignItems: 'center' }}>
        {node.children.length > 0 && <IconButton tabIndex={-1} aria-label={expanded ? t('orchestration.collapse') : t('orchestration.expand')} onClick={(event) => { event.stopPropagation(); toggle(); }}><Icon name="chevron-right" rotate={expanded ? 90 : 0} size={14} /></IconButton>}
        <ListRow size="sm" selected={selectedId === window.id} title={<><WindowIdChip id={window.id} /> {window.label || window.tmuxTarget}</>} chips={<WindowActivityIndicator status={activityStatus(window.serverName, window.tmuxTarget)} />} description={<span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', flexWrap: 'wrap' }}>{projects.slice(0, 3).map((project) => <ProjectAvatar key={project.id} project={project} size={18} />)}{projects.length > 3 && `+${projects.length - 3}`} {t('orchestration.links', { count: window.links.total })} {window.links.serverNames.filter((name) => name !== window.serverName).join(', ')} {window.lastInteractionAt && formatRelativeTime(window.lastInteractionAt)}</span>} style={{ flex: 1, minWidth: 0, listStyle: 'none' }} />
      </div>
      {expanded && node.children.length > 0 && <div role="group">{node.children.map((child) => renderNode(child, depth + 1))}</div>}
    </div>;
  };
  if (status === 'loading' || snapshotStatus === 'loading') return <LoadingState />;
  if (snapshotStatus === 'error') return <Notice tone="danger" action={<Button onClick={retrySnapshot}>{t('orchestration.retry')}</Button>}>{t('orchestration.loadError')}</Notice>;
  if (status === 'error' && !windows.length) return <Notice tone="danger" action={<Button onClick={refresh}>{t('orchestration.retry')}</Button>}>{t('orchestration.loadError')}</Notice>;
  return <>
    {status === 'error' && <Notice tone="danger" action={<Button onClick={refresh}>{t('orchestration.retry')}</Button>}>{t('orchestration.loadError')}</Notice>}
    {!windows.length ? <EmptyState title={t('orchestration.empty')} /> : <><FormInput aria-label={t('orchestration.search')} value={search} onChange={(event) => setSearch(event.target.value)} />{states.map((state) => {
      const nodes = tree.filter((node) => orchestratorState(node.window, activityStatus(node.window.serverName, node.window.tmuxTarget)) === state && matches(node));
      return <ObjectSection key={state} id={state} label={t(`orchestration.${state}`)} count={nodes.length} collapsed={sectionClosed.has(state)} onToggleCollapse={() => setSectionClosed((prev) => { const next = new Set(prev); if (next.has(state)) next.delete(state); else next.add(state); return next; })}><div role="tree" aria-label={t(`orchestration.${state}`)}>{nodes.map((node) => renderNode(node, 0))}</div></ObjectSection>;
    })}</>}
    {contextMenu.menu && <ContextMenu menu={contextMenu.menu} onClose={contextMenu.hide} />}
    {actions.wakeDialog}
    {actions.respawnResourceWarning && <ResourceWarningDialog open title={t('windows.respawnFailed')} actionLabel={t('windows.respawn')} resources={actions.respawnResourceWarning?.resources ?? null} onCancel={() => actions.setRespawnResourceWarning(null)} onForce={() => actions.respawnResourceWarning?.retry()} />}
    {actions.confirmDialog && <ConfirmDialog open title={actions.confirmDialog?.title ?? ''} message={actions.confirmDialog?.message ?? ''} onConfirm={actions.confirmDialog?.onConfirm ?? (() => {})} onCancel={() => actions.setConfirmDialog(null)} loading={actions.windowActionLoading} confirmLabel={actions.confirmDialog?.confirmLabel} confirmVariant={actions.confirmDialog?.confirmVariant} />}
  </>;
}
