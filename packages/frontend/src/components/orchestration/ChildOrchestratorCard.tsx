import { Button } from '../ui/Button';
import { WindowIdChip } from '../ui/WindowIdChip';
interface Props { title: string; windowId: number; linkedCount: number; runningCount: number; linkedLabel: string; runningLabel: string; summary?: string; enterLabel: string; onEnter: () => void }
export function ChildOrchestratorCard({ title, windowId, linkedCount, runningCount, linkedLabel, runningLabel, summary, enterLabel, onEnter }: Props) {
  return <article style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)' }}><strong>{title}</strong><div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', color: 'var(--text-dim)', fontSize: 'var(--font-xs)' }}><WindowIdChip id={windowId} /><span>{linkedLabel} {linkedCount}</span><span>{runningLabel} {runningCount}</span>{summary && <span>{summary}</span>}<Button size="sm" onClick={onEnter}>{enterLabel}</Button></div></article>;
}
