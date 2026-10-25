import { useTranslation } from 'react-i18next';
import { Chip } from '../ui';
import type { ChipTone } from '../ui';
import type { UninstallOutcome, UninstallStep } from '../../lib/serverDeletion';

const OUTCOME_TONE: Record<UninstallOutcome, ChipTone> = { done: 'green', absent: 'default', failed: 'red', skipped: 'orange' };

interface UninstallStepListProps {
  steps: readonly UninstallStep[];
}

/** The result of each step on the host: the chip says what happened, the reason is under the step. */
export function UninstallStepList({ steps }: UninstallStepListProps) {
  const { t } = useTranslation('servers');
  return (
    <ul aria-label={t('danger.hostRemoval.stepsLabel')} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      {steps.map((step) => (
        <li key={step.id} style={{ fontSize: 'var(--font-sm)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--text)' }}>{t(`danger.hostRemoval.steps.${step.id}`)}</span>
            <Chip tone={OUTCOME_TONE[step.outcome]}>{t(`danger.hostRemoval.outcomes.${step.outcome}`)}</Chip>
          </div>
          {step.detail !== undefined && (
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', marginTop: 'var(--space-1)', lineHeight: 'var(--leading-body)', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{step.detail}</div>
          )}
        </li>
      ))}
    </ul>
  );
}
