import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Button } from '../ui';
import { paths } from '../../paths';

interface Props { reason: string; onRetry: () => void; }

export function StorageUnreachable({ reason, onRetry }: Props) {
  const { t } = useTranslation('storage');
  const navigate = useNavigate();
  return <div style={{ padding: 'var(--space-4)', display: 'grid', gap: 'var(--space-3)' }} role="status">
    <strong>{t('unreachable.title')}</strong>
    <p style={{ color: 'var(--text-dim)', fontSize: 'var(--font-sm)', overflowWrap: 'anywhere' }}>{t(`unreachable.reasons.${reason}`, { defaultValue: t('unreachable.reasons.unknown') })}</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
      <Button onClick={onRetry}>{t('retry')}</Button>
      <Button onClick={() => navigate(paths.settings('storage'))}>{t('openSettings')}</Button>
    </div>
  </div>;
}
