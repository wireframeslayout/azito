import type { ReactNode } from 'react';
import { Button } from '../ui/Button';

interface Props { title: string; status: string; detail?: string; timestamp?: string; snapshot?: ReactNode; openLabel: string; unlinkLabel: string; onOpen: () => void; onUnlink: () => void; actions?: ReactNode }
export function LinkedWindowCard({ title, status, detail, timestamp, snapshot, openLabel, unlinkLabel, onOpen, onUnlink, actions }: Props) {
  return <article style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)' }}>
    <button type="button" onClick={onOpen} aria-label={openLabel} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'transparent', border: 0, color: 'var(--text)' }}>
      <strong>{title}</strong> <span>{status}</span><div style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)' }}>{detail} {timestamp}</div>
    </button>
    {snapshot}<div>{actions}<Button size="sm" onClick={onUnlink}>{unlinkLabel}</Button></div>
  </article>;
}
