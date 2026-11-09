import { useState } from 'react';
import { Button } from '../ui/Button';
import { GlassPopover } from '../ui/GlassPopover';
import type { LinkTarget } from '../../hooks/useOrchestrationLinks';

export interface LinkCandidate { key: string; label: string; target: LinkTarget; group: string; disabled?: boolean }
interface Props { open: boolean; onClose: () => void; candidates: LinkCandidate[]; searchLabel: string; emptyLabel: string; error?: string | null; excludedWindowIds?: number[]; linkedTargets?: LinkTarget[]; onAdd: (target: LinkTarget) => void }
export function AddLinkPopover({ open, onClose, candidates, searchLabel, emptyLabel, error, excludedWindowIds = [], linkedTargets = [], onAdd }: Props) {
  const [query, setQuery] = useState('');
  const matches = candidates.filter(candidate => {
    const target = candidate.target;
    if ('targetWindowId' in target && excludedWindowIds.includes(target.targetWindowId)) return false;
    if (linkedTargets.some(linked => 'targetWindowId' in target && 'targetWindowId' in linked ? target.targetWindowId === linked.targetWindowId : 'taskId' in target && 'taskId' in linked && target.taskId === linked.taskId)) return false;
    return candidate.label.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  });
  const groups = [...new Set(matches.map(candidate => candidate.group))];
  return <GlassPopover open={open} onClose={onClose} ariaLabel={searchLabel}>
    <input aria-label={searchLabel} value={query} onChange={event => setQuery(event.target.value)} />
    {error && <p role="alert">{error}</p>}
    {matches.length === 0 ? <p>{emptyLabel}</p> : groups.map(group => <section key={group}><h3>{group}</h3><ul>{matches.filter(candidate => candidate.group === group).map(candidate => <li key={candidate.key}><Button disabled={candidate.disabled} onClick={() => onAdd(candidate.target)}>{candidate.label}</Button></li>)}</ul></section>)}
  </GlassPopover>;
}
