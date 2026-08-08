import { useTranslation } from 'react-i18next';

export type SecretNamesState = 'loading' | 'loaded' | 'error';

interface SecretNamesValueProps {
  /** Project secret NAMES only — this component (and every caller) must never receive a `value` field. */
  names: string[];
  state?: SecretNamesState;
  onRetry?: () => void;
}

/**
 * Shared "which secrets does/will this execution receive" display (Issue
 * #28 design v3 §9 / Phase D-3) — names only, never values. Extracted from
 * the untrusted-import execution-approval panel's inline rendering
 * (`modules/tasks/turns`'s server-side counterpart is
 * `projectSecretRepo.findByProject(...).map(s => s.name)`) so a second
 * caller (TaskGitTab's persistent "secrets injected" field, shown for every
 * task's execution context, not just the untrusted-approval gate) reuses
 * the exact same loading/error/empty presentation instead of a second
 * implementation that could drift from it.
 */
export function SecretNamesValue({ names, state = 'loaded', onRetry }: SecretNamesValueProps) {
  const { t } = useTranslation('tasks');

  if (state === 'error') {
    return (
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--danger)', wordBreak: 'break-word', fontSize: 'var(--font-sm)' }}>
          {t('untrustedImport.secretsLoadError')}
        </span>
        {onRetry && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={onRetry}
            style={{ padding: '2px 8px', fontSize: 'var(--font-xs)' }}
          >
            {t('untrustedImport.secretsRetry')}
          </button>
        )}
      </span>
    );
  }

  return (
    <span style={{ color: 'var(--text)', wordBreak: 'break-word', fontSize: 'var(--font-sm)' }}>
      {state === 'loading'
        ? t('executionApproval.loading')
        : (names.length > 0 ? names.join(', ') : t('executionApproval.noSecrets'))}
    </span>
  );
}
