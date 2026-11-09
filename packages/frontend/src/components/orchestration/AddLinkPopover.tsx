import { useState } from 'react';
import { Button } from '../ui/Button';
import type { LinkTarget } from '../../hooks/useOrchestrationLinks';

export interface LinkCandidate { key: string; label: string; target: LinkTarget; disabled?: boolean }
interface Props { candidates: LinkCandidate[]; searchLabel: string; emptyLabel: string; error?: string | null; excludedWindowIds?: number[]; linkedTargets?: LinkTarget[]; onAdd: (target: LinkTarget) => void }
export function AddLinkPopover({ candidates, searchLabel, emptyLabel, error, excludedWindowIds = [], linkedTargets = [], onAdd }: Props) {
  const [query, setQuery] = useState('');
  const matches = candidates.filter(candidate => {
    const target = candidate.target;
    if ('targetWindowId' in target && excludedWindowIds.includes(target.targetWindowId)) return false;
    if (linkedTargets.some(linked => 'targetWindowId' in target && 'targetWindowId' in linked ? target.targetWindowId === linked.targetWindowId : 'taskId' in target && 'taskId' in linked && target.taskId === linked.taskId)) return false;
    return candidate.label.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  });
  return <div style={{ background: 'var(--bg-elevated)', padding: 'var(--space-3)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
    <input aria-label={searchLabel} value={query} onChange={event => setQuery(event.target.value)} />
    {error && <p role="alert">{error}</p>}
    {matches.length === 0 ? <p>{emptyLabel}</p> : <ul>{matches.map(candidate => <li key={candidate.key}><Button disabled={candidate.disabled} onClick={() => onAdd(candidate.target)}>{candidate.label}</Button></li>)}</ul>}
  </div>;
}
