import { useTranslation } from 'react-i18next';
import type { LookoutSections } from '../../lib/lookoutSummary';
export function LookoutCounts({ counts, activityKnown = true }: { counts: LookoutSections['counts']; activityKnown?: boolean }) {
  const { t } = useTranslation('lookout');
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 'var(--space-2)', padding: 'var(--space-3) 0' }}>
    {(['attention', 'active', 'finished', 'failed'] as const).map(key => <div key={key} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-1)', padding: 'var(--space-2)', minWidth: 0 }}><div style={{ fontSize: 'var(--font-xl)', fontWeight: 700, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', color: { attention: 'var(--warning)', active: 'var(--accent)', finished: 'var(--success)', failed: 'var(--danger)' }[key] }}>{!activityKnown ? '—' : counts[key]}</div><div style={{ color: 'var(--text-dim)', fontSize: 'var(--font-2xs)', overflowWrap: 'anywhere' }}>{t(`counts.${key}`)}</div></div>)}
  </div>;
}
