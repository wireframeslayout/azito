import { useState } from 'react';
import { Button } from '../ui/Button';
import type { LinkTarget } from '../../hooks/useOrchestrationLinks';

export interface LinkCandidate { key: string; label: string; target: LinkTarget; disabled?: boolean }
interface Props { candidates: LinkCandidate[]; searchLabel: string; emptyLabel: string; error?: string | null; onAdd: (target: LinkTarget) => void }
export function AddLinkPopover({ candidates, searchLabel, emptyLabel, error, onAdd }: Props) {
  const [query, setQuery] = useState('');
  const matches = candidates.filter(candidate => candidate.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <div style={{ background: 'var(--bg-elevated)', padding: 'var(--space-3)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
    <input aria-label={searchLabel} value={query} onChange={event => setQuery(event.target.value)} />
    {error && <p role="alert">{error}</p>}
    {matches.length === 0 ? <p>{emptyLabel}</p> : <ul>{matches.map(candidate => <li key={candidate.key}><Button disabled={candidate.disabled} onClick={() => onAdd(candidate.target)}>{candidate.label}</Button></li>)}</ul>}
  </div>;
}
