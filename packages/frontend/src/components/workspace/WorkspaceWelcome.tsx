import { useTranslation } from 'react-i18next';
import AzitoLogo from '../AzitoLogo';

interface WorkspaceWelcomeProps {
  onCreateProject: () => void;
}

const STEPS = [
  { number: '01', labelKey: 'welcome.step1' },
  { number: '02', labelKey: 'welcome.step2' },
  { number: '03', labelKey: 'welcome.step3' },
] as const;

export default function WorkspaceWelcome({ onCreateProject }: WorkspaceWelcomeProps) {
  const { t } = useTranslation('workspace');
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      gap: 24,
      padding: 'var(--space-4)',
    }}>
      <AzitoLogo height={38} />

      <div style={{
        textAlign: 'center',
        color: 'var(--text-dim)',
        fontSize: 'var(--font-sm)',
        lineHeight: 1.6,
      }}>
        <p style={{ margin: 0 }}>{t('welcome.createFirst')}</p>
        <p style={{ margin: 0 }}>{t('welcome.description')}</p>
      </div>

      <button
        className="ws-welcome-cta"
        onClick={onCreateProject}
        style={{
          background: 'var(--accent)',
          color: 'var(--surface-base)',
          border: 'none',
          borderRadius: 'var(--radius-md)',
          padding: '10px 24px',
          fontSize: 'var(--font-base)',
          fontWeight: 600,
          fontFamily: 'inherit',
          cursor: 'pointer',
          transition: 'filter 0.15s ease',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.filter = 'brightness(1.15)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.filter = 'none'; }}
      >
        {t('welcome.newProject')}
      </button>

      <div style={{
        display: 'flex',
        gap: 'var(--space-3)',
        flexWrap: 'wrap',
        justifyContent: 'center',
        marginTop: 'var(--space-2)',
      }}>
        {STEPS.map((step) => (
          <div
            key={step.number}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              background: 'var(--bg-card)',
              borderRadius: 'var(--radius-lg)',
              padding: '8px 14px',
            }}
          >
            <span style={{
              color: 'var(--accent)',
              fontSize: 'var(--font-2xs)',
              fontWeight: 700,
              letterSpacing: '0.02em',
            }}>
              {step.number}
            </span>
            <span style={{
              color: 'var(--text-dim)',
              fontSize: 'var(--font-sm)',
            }}>
              {t(step.labelKey)}
            </span>
          </div>
        ))}
      </div>

      <style>{`
        .ws-welcome-cta:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 2px;
        }
        @media (prefers-reduced-motion: reduce) {
          .ws-welcome-cta { transition: none !important; }
        }
      `}</style>
    </div>
  );
}
