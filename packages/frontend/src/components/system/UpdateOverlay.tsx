import { useTranslation } from 'react-i18next';
import { useSystemUpdate } from '../../hooks/useSystemUpdate';
import type { UpdateStep } from '../../hooks/useSystemUpdate';
import { InstallSteps, type InstallStep } from '../ui/InstallSteps';
import { Spinner } from '../ui/Spinner';
import { Icon } from '../ui/Icon';

const STEP_LABEL_KEYS: Record<UpdateStep, string> = {
  download: 'updateOverlay.steps.download',
  verify: 'updateOverlay.steps.verify',
  extract: 'updateOverlay.steps.extract',
  'smoke-test': 'updateOverlay.steps.smokeTest',
  switch: 'updateOverlay.steps.switch',
  restart: 'updateOverlay.steps.restart',
  'health-check': 'updateOverlay.steps.healthCheck',
};

function shortSha(version: string): string {
  return version.length > 7 ? version.slice(0, 7) : version;
}

export function UpdateOverlay() {
  const { t } = useTranslation('settings');
  const { progress, showOverlay, dismissOverlay } = useSystemUpdate();

  if (!showOverlay) return null;

  const state = progress?.state ?? null;
  const isSuccess = state?.status === 'success';
  const isFailed = state?.status === 'failed';
  const isRestarting = !isSuccess && !isFailed && state?.step === 'restart';
  const isRunning = !isSuccess && !isFailed;
  const canClose = isSuccess || isFailed;

  const steps: InstallStep[] = state
    ? state.steps.map((s) => ({
      step: t(STEP_LABEL_KEYS[s.step] ?? s.step),
      status: s.status,
      message: s.message,
    }))
    : [];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('updateOverlay.ariaLabel')}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'var(--overlay)',
        backdropFilter: 'blur(3px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div style={{
        width: 480,
        maxWidth: 'calc(100vw - 32px)',
        maxHeight: 'calc(100vh - 64px)',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        overflow: 'hidden',
      }}>
        <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: 'var(--font-lg)', fontWeight: 600, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 10 }}>
            {isRunning && <Spinner size={14} />}
            {isSuccess && <span style={{ color: 'var(--success)' }}>✓</span>}
            {isFailed && <span style={{ color: 'var(--danger)' }}>✗</span>}
            <span>
              {isSuccess ? t('updateOverlay.completed') : isFailed ? t('updateOverlay.failed') : t('updateOverlay.inProgress')}
            </span>
          </div>
          {state && (
            <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', fontFamily: 'var(--mono)', marginTop: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
              {shortSha(state.fromVersion)} <Icon name="arrow-right" size={14} /> {shortSha(state.toVersion)}
            </div>
          )}
        </div>

        {steps.length > 0 && (
          <div style={{ padding: '4px 20px', borderBottom: '1px solid var(--border)' }}>
            <InstallSteps steps={steps} />
          </div>
        )}

        {progress && progress.log.length > 0 && (
          <div style={{
            flex: 1,
            minHeight: 80,
            maxHeight: 200,
            overflowY: 'auto',
            background: 'var(--bg-solid)',
            padding: '10px 20px',
            fontFamily: 'var(--mono)',
            fontSize: 'var(--font-xs)',
            color: 'var(--text-dim)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}>
            {progress.log.join('\n')}
          </div>
        )}

        {isFailed && state?.error && (
          <div style={{ padding: '10px 20px', color: 'var(--danger)', fontSize: 'var(--font-sm)' }}>
            {state.error}
          </div>
        )}

        <div style={{
          padding: '14px 20px',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}>
          <span style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 6 }}>
            {isRunning && (
              <>
                <Spinner size={10} />
                {isRestarting ? t('updateOverlay.waitingForServer') : t('updateOverlay.doNotClose')}
              </>
            )}
            {isSuccess && t('updateOverlay.reloading')}
          </span>
          <button
            className="btn btn-ghost btn-sm"
            onClick={dismissOverlay}
            disabled={!canClose}
          >
            {t('updateOverlay.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
