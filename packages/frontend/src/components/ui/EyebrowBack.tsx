import { useState } from 'react';
import { useTranslation } from 'react-i18next';

interface EyebrowBackProps {
  label: string;
  onBack: () => void;
}

/**
 * Small "back to X" affordance shown above a page/form title, used to restore
 * a navigation path back to the tab that opened the current one (see
 * useTabPersistence's opener-tab tracking).
 */
export function EyebrowBack({ label, onBack }: EyebrowBackProps) {
  const { t } = useTranslation('common');
  const [hover, setHover] = useState(false);

  return (
    <button
      type="button"
      onClick={onBack}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label={t('navigation.backTo', { label })}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        background: hover ? 'var(--accent-a08)' : 'none',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        padding: '3px 6px',
        marginLeft: -6,
        marginBottom: 2,
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: 'var(--font-xs)',
        fontWeight: 600,
        letterSpacing: '0.09em',
        textTransform: 'uppercase',
        color: hover ? 'var(--accent)' : 'var(--text-dim)',
        transition: 'color 0.15s ease, background 0.15s ease',
      }}
    >
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M15 19l-7-7 7-7" />
      </svg>
      {label}
    </button>
  );
}
