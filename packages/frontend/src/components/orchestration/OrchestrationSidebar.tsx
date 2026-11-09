import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useOrchestrators } from '../../hooks/useOrchestrators';
import { buildOrchestrationTree, type OrchestrationNode } from '../../lib/orchestrationModel';
import { LoadingState } from '../ui';

export interface OrchestrationSidebarProps {
  selectedId?: number;
  onSelect: (id: number) => void;
  onRemove?: (id: number) => void;
}
export function OrchestrationSidebar({ selectedId, onSelect, onRemove }: OrchestrationSidebarProps): ReactNode {
  const { t } = useTranslation('workspace');
  const { windows, status, refresh } = useOrchestrators();
  const [search, setSearch] = useState('');
  const [closed, setClosed] = useState<Set<number>>(new Set());
  const matches = (node: OrchestrationNode): boolean => `${node.window.label ?? ''} ${node.window.tmuxTarget} ${node.window.serverName}`.toLowerCase().includes(search.toLowerCase()) || node.children.some(matches);
  const renderNode = (node: OrchestrationNode, depth: number): ReactNode => {
    if (!matches(node)) return null;
    const expanded = !closed.has(node.window.id) || !!search;
    return <div key={node.window.id} role="treeitem" aria-level={depth + 1} aria-expanded={node.children.length ? expanded : undefined} aria-selected={selectedId === node.window.id}>
      <div style={{ display: 'flex', paddingLeft: `calc(var(--space-3) * ${depth})` }}>
        {node.children.length > 0 && <button aria-label={expanded ? t('orchestration.collapse') : t('orchestration.expand')} onClick={() => setClosed((previous) => { const next = new Set(previous); if (next.has(node.window.id)) next.delete(node.window.id); else next.add(node.window.id); return next; })}>{expanded ? '−' : '+'}</button>}
        <button onClick={() => onSelect(node.window.id)} style={{ flex: 1, minWidth: 0, textAlign: 'left', padding: 'var(--space-2)', background: selectedId === node.window.id ? 'var(--purple-a15)' : 'transparent', color: 'var(--text)', border: 0, cursor: 'pointer' }}>{node.window.label || node.window.tmuxTarget} · {node.window.serverName}</button>
        {onRemove && <button onClick={() => onRemove(node.window.id)} aria-label={t('orchestration.removeRole')}>×</button>}
      </div>
      {expanded && node.children.length > 0 && <div role="group">{node.children.map((child) => renderNode(child, depth + 1))}</div>}
    </div>;
  };
  if (status === 'loading') return <LoadingState />;
  if (status === 'error') return <div role="alert">{t('orchestration.loadError')} <button onClick={refresh}>{t('orchestration.retry')}</button></div>;
  return <><input aria-label={t('orchestration.search')} value={search} onChange={(event) => setSearch(event.target.value)} /><div role="tree">{buildOrchestrationTree(windows).map((node) => renderNode(node, 0))}</div></>;
}
