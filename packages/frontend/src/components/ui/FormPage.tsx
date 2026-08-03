import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './Button';
import { EyebrowBack } from './EyebrowBack';
import { useIsMobile } from '../../hooks/useIsMobile';

interface FormPageProps {
  title: ReactNode;
  submitLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
  loading?: boolean;
  loadingLabel?: string;
  disabled?: boolean;
  error?: string | null;
  children: ReactNode;
  /** Label of the tab this form was opened from (e.g. "Units", "Robin"). Shown as an EyebrowBack above the title. */
  backLabel?: string;
  /** Navigates back to the opener tab. Only rendered when backLabel is also set. */
  onBack?: () => void;
}

export function FormPage({ title, submitLabel, onSubmit, onCancel, loading, loadingLabel, disabled, error, children, backLabel, onBack }: FormPageProps) {
  const { t } = useTranslation('common');
  const isMobile = useIsMobile();
  const showBack = !!(backLabel && onBack);
  // On mobile, the back affordance replaces Cancel; on desktop both are shown.
  const showCancel = !isMobile || !showBack;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: 'var(--space-3) var(--space-4)', borderBottom: '1px solid var(--border)',
        background: 'var(--bg-card)', flexShrink: 0,
        position: 'sticky', top: 0, zIndex: 10,
        gap: 12,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {showBack && <EyebrowBack label={backLabel!} onBack={onBack!} />}
          <h2 style={{
            fontSize: 'var(--font-lg)', fontWeight: 600, margin: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {title}
          </h2>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {showCancel && (
            <button
              onClick={onCancel}
              style={{
                padding: '6px 16px', background: 'var(--bg)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)', color: 'var(--text)', fontSize: 'var(--font-md)', cursor: 'pointer',
              }}
            >
              {t('actions.cancel')}
            </button>
          )}
          <Button
            variant="primary"
            onClick={onSubmit}
            loading={loading}
            loadingLabel={loadingLabel}
            disabled={disabled}
            style={{ padding: '6px 16px', fontSize: 'var(--font-md)' }}
          >
            {submitLabel}
          </Button>
        </div>
      </div>

      {error && (
        <div role="alert" style={{
          padding: '8px 12px', margin: 'var(--space-4) var(--space-4) 0', borderRadius: 'var(--radius-sm)',
          background: 'var(--danger-a15)', border: '1px solid var(--danger-a35)',
          color: 'var(--danger)', fontSize: 'var(--font-md)',
        }}>
          {error}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: 'var(--space-6) var(--space-4)' }}>
          {children}
        </div>
      </div>
    </div>
  );
}
