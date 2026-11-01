import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { apiWithStatus } from '../../api/client';
import { paths } from '../../paths';
import { Button, CopyableCommand } from '../ui';
import type { StorageOnboardingInfo, StorageOption } from './types';

interface Props { onboarding: StorageOnboardingInfo; onConfigured: () => void; onLater: () => void; }

export function StorageOnboarding({ onboarding, onConfigured, onLater }: Props) {
  const { t } = useTranslation('storage');
  const navigate = useNavigate();
  const [showMinio, setShowMinio] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  const select = async (option: StorageOption): Promise<void> => {
    if (option.type === 'settings') { navigate(paths.settings('storage')); return; }
    if (option.type === 'minio') { setShowMinio((value) => !value); return; }
    if (option.type !== 'managed') return;
    if (!option.endpoint || !option.bucket) { setError(true); return; }
    setSaving(true);
    setError(false);
    try {
      const result = await apiWithStatus('/storage/settings', {
        method: 'PUT', body: JSON.stringify({ endpoint: option.endpoint, bucket: option.bucket }),
      });
      if (result.status < 200 || result.status >= 300) throw new Error('save failed');
      onConfigured();
    } catch { setError(true); } finally { setSaving(false); }
  };

  return <div style={{ padding: 'var(--space-4)', display: 'grid', gap: 'var(--space-3)', overflowY: 'auto' }}>
    <div style={{ display: 'grid', gap: 'var(--space-1)' }}>
      <strong>{t('onboarding.title')}</strong>
      <p style={{ color: 'var(--text-dim)', fontSize: 'var(--font-sm)' }}>{t('onboarding.description')}</p>
    </div>
    {onboarding.options.length === 0 && <p role="status">{t('onboarding.empty')}</p>}
    {onboarding.options.map((option, index) => {
      const title = onboarding.source === 'oss' ? t(`onboarding.${option.type}.title`) : option.title;
      const description = onboarding.source === 'oss' ? t(`onboarding.${option.type}.description`) : option.description;
      const content = <><strong>{title}</strong><span style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)' }}>{description}</span></>;
      const style = { display: 'grid', gap: 'var(--space-1)', textAlign: 'left' as const, padding: 'var(--space-3)', background: 'var(--bg-card)', borderRadius: 'var(--radius-md)', color: 'var(--text)', overflowWrap: 'anywhere' as const };
      return option.type === 'link' && option.url
        ? <a key={index} className="row-hover" style={style} href={option.url} target="_blank" rel="noopener noreferrer">{content}</a>
        : <button key={index} type="button" className="row-hover" style={{ ...style, border: '1px solid var(--border)', cursor: 'pointer' }} disabled={saving} onClick={() => void select(option)}>{content}</button>;
    })}
    {showMinio && <div style={{ display: 'grid', gap: 'var(--space-2)' }}>
      <p style={{ fontSize: 'var(--font-sm)' }}>{t('onboarding.minio.instructions')}</p>
      <CopyableCommand command="docker compose up -d" />
      <Button onClick={() => navigate(paths.settings('storage'))}>{t('openSettings')}</Button>
    </div>}
    {saving && <p role="status">{t('saving')}</p>}
    {error && <p role="alert" style={{ color: 'var(--danger)' }}>{t('saveError')}</p>}
    <p style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)' }}>{t('onboarding.later')}</p>
    <Button variant="ghost" onClick={onLater}>{t('onboarding.configureLater')}</Button>
  </div>;
}
