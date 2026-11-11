import type { ReactNode } from 'react';
import { Button } from '../ui/Button';
import { IconButton } from '../ui/IconButton';
import { Icon } from '../ui/Icon';
import { WindowIdChip } from '../ui/WindowIdChip';
import IssueRefChip from '../IssueRefChip';
import { parseSourceRef } from '../../lib/issueRef';

interface Props {
  source?: string; sourceRef?: string | null;
  title: string; status: string; windowId?: number; statusTone?: 'attention' | 'running' | 'completed'; detail?: string; timestamp?: string; snapshot?: ReactNode;
  openLabel: string; unlinkLabel: string; onOpen?: () => void; onUnlink: () => void; expandLabel?: string; onExpand?: () => void;
  attention?: boolean; waitingLabel?: string; closedLabel?: string; sleepingLabel?: string;
  wakeLabel?: string; onWake?: () => void; waking?: boolean;
  acknowledgeLabel?: string; onAcknowledge?: () => void; acknowledged?: boolean;
}
export function LinkedWindowCard({ source, sourceRef, title, status, detail, timestamp, snapshot, openLabel, unlinkLabel, onOpen, onUnlink, expandLabel, onExpand, attention, waitingLabel, closedLabel, sleepingLabel, wakeLabel, onWake, waking, acknowledgeLabel, onAcknowledge, acknowledged, windowId, statusTone }: Props) {
  return <article className="linked-window-card" style={{ position: 'relative', minWidth: 0, overflowWrap: 'anywhere', background: 'var(--bg-card)', border: attention ? '1px solid var(--warning)' : '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 'var(--space-3)' }}>
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }}><span aria-hidden="true" style={{ color: statusTone === 'attention' ? 'var(--warning)' : statusTone === 'running' ? 'var(--success)' : 'var(--text-dim)' }}>●</span><strong style={{ flex: 1, minWidth: 0 }}>{onOpen ? <button className="linked-window-card-open" aria-label={openLabel} onClick={onOpen}>{title}</button> : title}</strong> <span>{status}</span>{windowId != null && <WindowIdChip id={windowId} />}</div>
    {!acknowledged && waitingLabel && <p>{waitingLabel}</p>}{!acknowledged && closedLabel && <p>{closedLabel}</p>}{!acknowledged && sleepingLabel && <p>{sleepingLabel}</p>}
    {!acknowledged && !closedLabel && <div onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>{snapshot}</div>}
    <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
      {sourceRef && parseSourceRef(sourceRef) && <IssueRefChip source={source} sourceRef={sourceRef} />}
      {!acknowledged && (detail || timestamp) && <span style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)' }}>{detail} {timestamp}</span>}
      <span style={{ flex: 1 }} />
      {!acknowledged && <>
      {onExpand && <IconButton aria-label={expandLabel} title={expandLabel} onClick={onExpand}><Icon name="external-link" size={16} /></IconButton>}
      {onWake && <Button size="sm" loading={waking} onClick={onWake}>{wakeLabel}</Button>}
      {onAcknowledge && !acknowledged && <Button size="sm" onClick={onAcknowledge}>{acknowledgeLabel}</Button>}
      <Button size="sm" onClick={onUnlink}>{unlinkLabel}</Button>
      </>}
    </div>
  </article>;
}
