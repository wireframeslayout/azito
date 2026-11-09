import { useTranslation } from 'react-i18next';
import type { LookoutItem } from '../../lib/lookoutSummary';
import { formatRelativeTime } from '../../utils/time';
import { Badge } from '../ui/Badge';
import { LookoutSummaryText } from './LookoutSummaryText';

export type LookoutSummary = { status: 'off' | 'pending' } | { status: 'error'; reason?: 'cli_not_found' | 'not_logged_in' | 'timeout' | 'failed' } | { status: 'ready'; text: string };
interface Props { item: LookoutItem; onOpen: (item: LookoutItem) => void; summary?: LookoutSummary }
export function LookoutRow({ item, onOpen, summary = { status: 'off' } }: Props) {
  const { t } = useTranslation('lookout');
  const updatedAt = item.status === 'finished' ? item.primaryRow?.finishedAt : item.task?.updatedAt;
  const tone = item.status === 'failed' ? 'red' : item.status === 'blocked' || item.status === 'waiting_input' || item.status === 'pending_approval' || item.status === 'phase_review' ? 'orange' : item.status === 'finished' ? 'green' : 'neutral';
  return <button type="button" className="lookout-row" onClick={() => onOpen(item)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 'var(--space-1)', width: '100%', padding: 'var(--space-3)', textAlign: 'left', color: 'var(--text)', border: `1px solid ${tone === 'red' ? 'var(--danger-a35)' : tone === 'orange' ? 'var(--warning-a35)' : 'var(--border)'}`, borderRadius: 'var(--radius-md)', marginBottom: 'var(--space-2)', cursor: 'pointer' }}>
    <span style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'space-between', alignItems: 'baseline' }}><strong style={{ overflowWrap: 'anywhere' }}>{item.title}</strong><Badge tone={tone} style={{ flexShrink: 0 }}>{t(`status.${item.status}`)}</Badge></span>
    {updatedAt != null && <span style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)' }}>{item.status === 'finished' ? formatRelativeTime(updatedAt) : t('updated', { time: formatRelativeTime(updatedAt) })}</span>}
    <LookoutSummaryText summary={summary} />
  </button>;
}
