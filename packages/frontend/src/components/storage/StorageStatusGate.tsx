import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { apiWithStatus } from '../../api/client';
import { Button, LoadingState } from '../ui';
import { StorageOnboarding } from './StorageOnboarding';
import { StorageUnreachable } from './StorageUnreachable';
import type { StorageStatus } from './types';

interface Props { projectId: number; children: ReactNode; }

export function StorageStatusGate({ projectId, children }: Props) {
  const { t } = useTranslation('storage');
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem('storage-onboarding-dismissed') === 'true'; } catch { return false; }
  });
  const dismiss = (value: boolean): void => {
    setDismissed(value);
    try {
      if (value) localStorage.setItem('storage-onboarding-dismissed', 'true');
      else localStorage.removeItem('storage-onboarding-dismissed');
    } catch { /* Storage is optional; state remains usable in this session. */ }
  };
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    setStatus(null);
    setError(false);
    apiWithStatus<StorageStatus>(`/projects/${projectId}/storage/status`).then(({ status: httpStatus, body }) => {
      if (httpStatus !== 200 || !['ready', 'unconfigured', 'unreachable'].includes(body.state)) throw new Error('invalid status');
      if (active) setStatus(body);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [projectId, attempt]);
  if (error) return <div role="alert" style={{ padding: 'var(--space-4)' }}>{t('statusError')} <Button onClick={retry}>{t('retry')}</Button></div>;
  if (!status) return <LoadingState />;
  if (status.state === 'ready') return <>{children}</>;
  if (status.state === 'unreachable') return <StorageUnreachable reason={status.reason} onRetry={retry} />;
  if (dismissed && status.onboarding.dismissible) return <div style={{ padding: 'var(--space-4)' }}><Button onClick={() => dismiss(false)}>{t('onboarding.title')}</Button></div>;
  return <StorageOnboarding onboarding={status.onboarding} onConfigured={retry} onLater={() => dismiss(true)} />;
}
