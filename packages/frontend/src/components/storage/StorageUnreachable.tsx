import { useState } from 'react';
import { apiWithStatus } from '../../api/client';
import { canCreateBucket } from './bucketAction';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button } from '../ui';
import { paths } from '../../paths';

interface Props { projectId: number; reason: string; onRetry: () => void; }

export function StorageUnreachable({ projectId, reason, onRetry }: Props) {
  const { t } = useTranslation('storage');
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const createBucket = async () => {
    setBusy(true); setError(false);
    try {
      const response = await apiWithStatus(`/projects/${projectId}/storage/bucket`, { method: 'POST' });
      if (response.status < 200 || response.status >= 300) throw new Error('Bucket creation failed');
      onRetry();
    } catch { setError(true); } finally { setBusy(false); }
  };
  return <div style={{ padding: 'var(--space-4)', display: 'grid', gap: 'var(--space-3)' }} role="status">
    <h2 style={{ fontSize: 'var(--font-md)' }}>{t('unreachable.title')}</h2>
    <p style={{ color: 'var(--text-dim)', fontSize: 'var(--font-sm)', overflowWrap: 'anywhere' }}>{t(`unreachable.reasons.${reason}`, { defaultValue: t('unreachable.reasons.unknown') })}</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
      {canCreateBucket(reason) && <Button onClick={() => void createBucket()} disabled={busy}>{busy ? t('unreachable.creatingBucket') : t('unreachable.createBucket')}</Button>}
      <Button onClick={onRetry} disabled={busy}>{t('retry')}</Button>
      <Button onClick={() => navigate(paths.settings('storage'))}>{t('openSettings')}</Button>
    </div>
    {error && <p role="alert" style={{ color: 'var(--danger)' }}>{t('unreachable.createBucketError')}</p>}
  </div>;
}
