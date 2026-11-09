import type { ReactNode } from 'react';
import { Button } from '../ui/Button';

interface Props {
  title: string; status: string; detail?: string; timestamp?: string; snapshot?: ReactNode;
  openLabel: string; unlinkLabel: string; onOpen?: () => void; onUnlink: () => void;
  attention?: boolean; waitingLabel?: string; closedLabel?: string; sleepingLabel?: string;
  wakeLabel?: string; onWake?: () => void; waking?: boolean;
  acknowledgeLabel?: string; onAcknowledge?: () => void; acknowledged?: boolean;
}
export function LinkedWindowCard({ title, status, detail, timestamp, snapshot, openLabel, unlinkLabel, onOpen, onUnlink, attention, waitingLabel, closedLabel, sleepingLabel, wakeLabel, onWake, waking, acknowledgeLabel, onAcknowledge, acknowledged }: Props) {
  return <article role={onOpen ? 'button' : undefined} tabIndex={onOpen ? 0 : undefined} aria-label={onOpen ? openLabel : undefined}
    onClick={onOpen} onKeyDown={event => { if (onOpen && event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onOpen(); } }} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: attention ? 'var(--space-4)' : 'var(--space-3)' }}>
    <div><strong>{title}</strong> <span>{status}</span></div>
    <div style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)' }}>{detail} {timestamp}</div>
    {waitingLabel && <p>{waitingLabel}</p>}{closedLabel && <p>{closedLabel}</p>}{sleepingLabel && <p>{sleepingLabel}</p>}
    {!acknowledged && <div onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>{snapshot}</div>}
    <div onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
      {onWake && <Button size="sm" loading={waking} onClick={onWake}>{wakeLabel}</Button>}
      {onAcknowledge && !acknowledged && <Button size="sm" onClick={onAcknowledge}>{acknowledgeLabel}</Button>}
      <Button size="sm" onClick={onUnlink}>{unlinkLabel}</Button>
    </div>
  </article>;
}
