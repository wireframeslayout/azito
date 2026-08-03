import { Icon } from '../ui/Icon';
import { useTranslation } from 'react-i18next';

interface TaskSummaryTabProps {
  summaryJson: string | null;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export default function TaskSummaryTab({ summaryJson }: TaskSummaryTabProps) {
  const { t } = useTranslation('tasks');
  if (!summaryJson) {
    return (
      <div style={{ color: 'var(--text-dim)', fontSize: 'var(--font-sm)', padding: '20px 0', textAlign: 'center' }}>
        {t('summary.noSummary')}
      </div>
    );
  }

  let summary: {
    phases?: Array<{
      phase: string;
      status: string;
      summary: string;
      tokensUsed?: { input?: number; output?: number };
      durationSeconds?: number;
    }>;
    totalTokens?: { input: number; output: number };
    completedAt?: string;
  };

  try {
    summary = JSON.parse(summaryJson);
  } catch {
    return (
      <div style={{ color: 'var(--text-dim)', fontSize: 'var(--font-sm)', padding: '20px 0', textAlign: 'center' }}>
        {t('summary.invalidData')}
      </div>
    );
  }

  if (!summary.phases?.length) {
    return (
      <div style={{ color: 'var(--text-dim)', fontSize: 'var(--font-sm)', padding: '20px 0', textAlign: 'center' }}>
        {t('summary.noPhaseData')}
      </div>
    );
  }

  return (
    <div style={{ fontSize: 'var(--font-md)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 'var(--font-2xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-dim)' }}>
          {t('summary.phases', { count: summary.phases.length })}
        </div>
        {summary.totalTokens && (
          <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)' }}>
            {t('summary.tokens', { value: formatTokens(summary.totalTokens.input + summary.totalTokens.output) })}
          </span>
        )}
      </div>

      <div>
        {summary.phases.map((p, i) => (
          <div key={i} style={{
            padding: '8px 0',
            borderBottom: i < summary.phases!.length - 1 ? '1px solid var(--border)' : 'none',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <span style={{ fontSize: 'var(--font-sm)', display: 'inline-flex', alignItems: 'center', color: p.status === 'completed' ? 'var(--success)' : 'var(--text-dim)' }}>
                {p.status === 'completed' ? <Icon name="check" size={14} /> : p.status === 'failed' ? <Icon name="close" size={14} /> : '○'}
              </span>
              <span style={{ fontSize: 'var(--font-sm)', fontWeight: 600, color: 'var(--text)', textTransform: 'capitalize' }}>{p.phase}</span>
              <span style={{ fontSize: 'var(--font-2xs)', color: p.status === 'completed' ? 'var(--success)' : 'var(--text-dim)' }}>{p.status}</span>
            </div>
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', lineHeight: 1.4, paddingLeft: 18 }}>{p.summary}</div>
            <div style={{ display: 'flex', gap: 12, marginTop: 3, paddingLeft: 18, fontSize: 'var(--font-2xs)', color: 'var(--text-dim)' }}>
              {p.tokensUsed && (
                <span>{t('summary.tokenIn', { value: formatTokens(p.tokensUsed.input ?? 0) })} / {t('summary.tokenOut', { value: formatTokens(p.tokensUsed.output ?? 0) })}</span>
              )}
              {p.durationSeconds != null && <span>{t('summary.duration', { seconds: p.durationSeconds })}</span>}
            </div>
          </div>
        ))}
      </div>

      {summary.totalTokens && (
        <div style={{
          marginTop: 8, paddingTop: 8,
          borderTop: '1px solid var(--border)',
          fontSize: 'var(--font-2xs)', color: 'var(--text-dim)',
          display: 'flex', justifyContent: 'space-between',
        }}>
          <span>{t('summary.total', { input: formatTokens(summary.totalTokens.input), output: formatTokens(summary.totalTokens.output) })}</span>
          <span style={{ fontStyle: 'italic' }}>{t('summary.estimated')}</span>
        </div>
      )}
      {summary.completedAt && (
        <div style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)', marginTop: 4 }}>
          {t('summary.completed', { date: new Date(summary.completedAt).toLocaleString() })}
        </div>
      )}
    </div>
  );
}
