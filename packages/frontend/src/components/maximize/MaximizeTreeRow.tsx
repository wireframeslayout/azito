import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { TaskTreeRowContent } from '../workspace/TaskTreeRow';
import type { MaximizeTreeRow as TreeRowModel } from '../../lib/maximizeTreeModel';

export function MaximizeTreeRow({ row, expanded, focused, selected, onFocus, onSelect, onToggle, level = 1 }: { row: TreeRowModel; expanded: ReadonlySet<string>; focused: string | null; selected: number | null; onFocus: (key: string) => void; onSelect: (id: number) => void; onToggle: (key: string) => void; level?: number }) {
  const { t } = useTranslation('workspace');
  const id = row.kind === 'window' ? row.window.id : row.windowId;
  const label = row.kind === 'task' ? row.task.title : row.window.label || row.window.tmuxTarget;
  const hasChildren = row.children.length > 0;
  return <div role="treeitem" aria-label={hasChildren || row.kind === 'task' ? label : undefined} aria-level={level} tabIndex={focused === row.key ? 0 : -1} data-key={row.key} className="row-hover maximize-tree-row" aria-selected={id !== null && id === selected} aria-expanded={hasChildren ? expanded.has(row.key) : undefined} onFocus={event => { if (event.target === event.currentTarget) onFocus(row.key); }} onClick={event => { event.stopPropagation(); if (id !== null) onSelect(id); }} style={{ padding: 'var(--space-1)', fontSize: 'var(--font-sm)', cursor: id === null ? 'default' : 'pointer', background: id !== null && id === selected ? 'var(--selected-bg-strong)' : undefined }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', minWidth: 0 }}>{row.kind === 'task' ? <TaskTreeRowContent task={row.task} expanded={expanded.has(row.key)} onToggle={() => onToggle(row.key)} /> : <>{hasChildren && <button tabIndex={-1} aria-label={t(expanded.has(row.key) ? 'maximize.collapse' : 'maximize.expand')} onClick={event => { event.stopPropagation(); onToggle(row.key); }}><Icon name="chevron-right" size={14} rotate={expanded.has(row.key) ? 90 : 0} /></button>}<Icon name={row.isChildOrchestrator ? 'orchestration' : 'terminal'} size={14} style={{ color: row.isChildOrchestrator ? 'var(--purple)' : 'var(--text-dim)', flexShrink: 0 }} /><span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>{row.isChildOrchestrator && <span style={{ color: 'var(--purple)', fontSize: 'var(--font-2xs)' }}>{t('maximize.childOrchestrator')}</span>}<span style={{ color: 'var(--text-dim)', fontSize: 'var(--font-2xs)' }}>W-{row.window.id}</span></>}{row.attention && <span style={{ color: 'var(--warning)', fontSize: 'var(--font-2xs)' }}>{t('linkedPanel.attention')}</span>}</div>
    {hasChildren && expanded.has(row.key) && <div role="group" style={{ paddingLeft: 'var(--space-3)' }}>{row.children.map(child => <MaximizeTreeRow key={child.key} row={child} expanded={expanded} focused={focused} selected={selected} onFocus={onFocus} onSelect={onSelect} onToggle={onToggle} level={level + 1} />)}</div>}
  </div>;
}
