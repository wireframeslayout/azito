import { useTranslation } from 'react-i18next';
import { Chip } from '../ui/Chip';
import type { LookoutSummary } from './LookoutRow';

export function LookoutSummaryText({ summary }: { summary?: LookoutSummary }) {
  const { t } = useTranslation('lookout');
  if (!summary || summary.status === 'off') return null;
  if (summary.status === 'pending') return <span role="status" aria-label={t('summary.pending')} style={{ display: 'block', width: '50%', height: 'var(--space-3)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-hover)' }} />;
  if (summary.status === 'error') return <span style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)' }}>{t('summary.error')}</span>;
  if (summary.status !== 'ready') return null;
  return <span style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)', color: 'var(--text-dim)', fontSize: 'var(--font-xs)', overflowWrap: 'anywhere' }}><Chip tone="purple">{t('summary.label')}</Chip><span>{summary.text}</span></span>;
}
