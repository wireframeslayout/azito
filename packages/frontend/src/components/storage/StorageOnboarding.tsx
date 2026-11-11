import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { apiWithStatus } from '../../api/client';
import { paths } from '../../paths';
import { Button, CopyableCommand, ListRow } from '../ui';
import { Icon } from '../ui/Icon';
import type { StorageOnboardingInfo, StorageOption } from './types';
import { getOnboardingText, getOptionText } from './onboardingText';

const wrappedTextStyle = { display: 'block', whiteSpace: 'normal', overflowWrap: 'anywhere' } as const;

interface Props { onboarding: StorageOnboardingInfo; onConfigured: () => void; onLater: () => void; }

export function StorageOnboarding({ onboarding, onConfigured, onLater }: Props) {
  const { t } = useTranslation('storage');
  const navigate = useNavigate();
  const [showMinio, setShowMinio] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  const select = async (option: StorageOption): Promise<void> => {
    if (option.kind === 'connect-s3') { navigate(paths.settings('storage')); return; }
    if (option.kind === 'local-minio') { setShowMinio((value) => !value); return; }
    if (option.kind !== 'managed') return;
    if (!option.defaults?.endpoint || !option.defaults.bucket) { setError(true); return; }
    setSaving(true);
    setError(false);
    try {
      const result = await apiWithStatus('/storage/settings', {
        method: 'PUT', body: JSON.stringify({ endpoint: option.defaults.endpoint, bucket: option.defaults.bucket }),
      });
      if (result.status < 200 || result.status >= 300) throw new Error('save failed');
      onConfigured();
    } catch { setError(true); } finally { setSaving(false); }
  };

  const text = getOnboardingText(onboarding, t);
  return <div style={{ padding: 'var(--space-4)', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 'var(--space-3)', minWidth: 0, overflowY: 'auto', overflowWrap: 'anywhere' }}>
    <div style={{ display: 'grid', gap: 'var(--space-1)' }}>
      <h2 style={{ fontSize: 'var(--font-md)' }}>{text.heading}</h2>
      <p style={{ color: 'var(--text-dim)', fontSize: 'var(--font-sm)' }}>{text.body}</p>
    </div>
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {onboarding.options.map((option) => {
        const { title, description } = getOptionText(onboarding, option, t);
        return <ListRow key={option.id} icon={<Icon name={option.kind === 'local-minio' ? 'servers' : option.kind === 'link' ? 'link' : 'storage'} />}
          title={<span style={wrappedTextStyle}>{title}</span>} description={description ? <span style={wrappedTextStyle}>{description}</span> : undefined} showChevron href={option.kind === 'link' ? option.href : undefined}
          onClick={option.kind === 'link' ? undefined : () => void select(option)} disabled={saving} />;
      })}
    </ul>
    {showMinio && <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 'var(--space-2)' }}>
      <p style={{ fontSize: 'var(--font-sm)' }}>{t('onboarding.minio.instructions')}</p>
      <CopyableCommand command="docker compose up -d" />
      <Button onClick={() => navigate(paths.settings('storage'))}>{t('openSettings')}</Button>
    </div>}
    {saving && <p role="status">{t('saving')}</p>}
    {error && <p role="alert" style={{ color: 'var(--danger)' }}>{t('saveError')}</p>}
    <p style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)' }}>{t('onboarding.later')}</p>
    {onboarding.dismissible && <Button variant="ghost" onClick={onLater}>{t('onboarding.configureLater')}</Button>}
  </div>;
}
