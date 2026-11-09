import type { ReactNode } from 'react';
import { Button } from '../ui/Button';
import { WindowIdChip } from '../ui/WindowIdChip';

interface Props {
  title: string; status: string; windowId?: number; statusTone?: 'attention' | 'running' | 'completed'; detail?: string; timestamp?: string; snapshot?: ReactNode;
  openLabel: string; unlinkLabel: string; onOpen?: () => void; onUnlink: () => void; expandLabel?: string; onExpand?: () => void;
  attention?: boolean; waitingLabel?: string; closedLabel?: string; sleepingLabel?: string;
  wakeLabel?: string; onWake?: () => void; waking?: boolean;
  acknowledgeLabel?: string; onAcknowledge?: () => void; acknowledged?: boolean;
}
export function LinkedWindowCard({ title, status, detail, timestamp, snapshot, openLabel, unlinkLabel, onOpen, onUnlink, expandLabel, onExpand, attention, waitingLabel, closedLabel, sleepingLabel, wakeLabel, onWake, waking, acknowledgeLabel, onAcknowledge, acknowledged, windowId, statusTone }: Props) {
  return <article className="linked-window-card" role={onOpen ? 'button' : undefined} tabIndex={onOpen ? 0 : undefined} aria-label={onOpen ? openLabel : undefined}
    onClick={onOpen} onKeyDown={event => { if (onOpen && event.target === event.currentTarget && event.key === 'Enter') { event.preventDefault(); onOpen(); } }} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: attention ? 'var(--space-4)' : 'var(--space-3)' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}><span aria-hidden="true" style={{ color: statusTone === 'attention' ? 'var(--warning)' : statusTone === 'running' ? 'var(--success)' : 'var(--text-dim)' }}>●</span><strong style={{ flex: 1 }}>{title}</strong> <span>{status}</span>{windowId != null && <WindowIdChip id={windowId} />}</div>
    {!acknowledged && <div style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)' }}>{detail} {timestamp}</div>}
    {!acknowledged && waitingLabel && <p>{waitingLabel}</p>}{!acknowledged && closedLabel && <p>{closedLabel}</p>}{!acknowledged && sleepingLabel && <p>{sleepingLabel}</p>}
    {!acknowledged && !closedLabel && <div onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>{snapshot}</div>}
    {!acknowledged && <div onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
      {onExpand && <Button size="sm" onClick={onExpand}>{expandLabel}</Button>}
      {onWake && <Button size="sm" loading={waking} onClick={onWake}>{wakeLabel}</Button>}
      {onAcknowledge && !acknowledged && <Button size="sm" onClick={onAcknowledge}>{acknowledgeLabel}</Button>}
      <Button size="sm" onClick={onUnlink}>{unlinkLabel}</Button>
    </div>}
  </article>;
}
