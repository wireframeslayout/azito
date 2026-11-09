import type { ReactNode } from 'react';
import type { Task } from '../../pages/workspace/types';
import { StatusDot } from '../StatusBadge';
import { Icon } from '../ui/Icon';

interface TaskTreeRowContentProps {
  task: Task;
  expanded: boolean;
  onToggle: () => void;
  activity?: ReactNode;
}

export function TaskTreeRowContent({ task, expanded, onToggle, activity }: TaskTreeRowContentProps) {
  return <>
    <button type="button" tabIndex={-1} aria-hidden="true" onClick={event => { event.stopPropagation(); onToggle(); }} style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', color: 'var(--text-dim)', flexShrink: 0, width: 14 }}><Icon name="chevron-right" size={14} rotate={expanded ? 90 : 0} /></button>
    <StatusDot status={task.status} />
    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</span>
    {activity}
    <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)', background: 'var(--bg)', borderRadius: 'var(--radius-sm)', padding: '1px 5px', flexShrink: 0 }}>#{task.id}</span>
  </>;
}
