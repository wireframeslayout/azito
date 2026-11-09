import { Button } from '../ui/Button';
interface Props { title: string; summary: string; enterLabel: string; onEnter: () => void }
export function ChildOrchestratorCard({ title, summary, enterLabel, onEnter }: Props) {
  return <article style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)' }}><strong>{title}</strong><p>{summary}</p><Button onClick={onEnter}>{enterLabel}</Button></article>;
}
