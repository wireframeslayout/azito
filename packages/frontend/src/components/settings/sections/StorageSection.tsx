import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import FormField from '../../FormField';
import { FormInput, Button, LoadingState } from '../../ui';

interface StorageSettingsData {
  endpoint: string;
  bucket: string;
  region: string;
  maxFileSize: number;
  useSsl: boolean;
}

export default function StorageSection() {
  const { t } = useTranslation('settings');
  const [endpoint, setEndpoint] = useState('');
  const [accessKey, setAccessKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [bucket, setBucket] = useState('');
  const [region, setRegion] = useState('');
  const [maxFileSize, setMaxFileSize] = useState('50');
  const [useSsl, setUseSsl] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  useEffect(() => {
    api<StorageSettingsData>('/storage/settings')
      .then((data) => {
        setEndpoint(data.endpoint || '');
        setBucket(data.bucket || '');
        setRegion(data.region || '');
        setMaxFileSize(String(Math.round((data.maxFileSize || 52428800) / (1024 * 1024))));
        setUseSsl(data.useSsl || false);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setStatus(null);
    try {
      const body: Record<string, unknown> = {
        endpoint: endpoint.trim(),
        bucket: bucket.trim(),
        region: region.trim(),
        max_file_size: parseInt(maxFileSize, 10) * 1024 * 1024,
        use_ssl: useSsl,
      };
      if (accessKey.trim()) body.access_key = accessKey.trim();
      if (secretKey.trim()) body.secret_key = secretKey.trim();
      const res = await api<{ ok?: boolean; error?: string }>('/storage/settings', {
        method: 'PUT', body: JSON.stringify(body),
      });
      if (res.ok) {
        setStatus({ type: 'success', message: 'Settings saved' });
        setAccessKey('');
        setSecretKey('');
      } else {
        setStatus({ type: 'error', message: res.error || 'Save failed' });
      }
    } catch (err: unknown) {
      setStatus({ type: 'error', message: (err as Error).message });
    } finally {
      setSaving(false);
      setTimeout(() => setStatus(null), 4000);
    }
  }, [endpoint, accessKey, secretKey, bucket, region, maxFileSize, useSsl]);

  if (loading) return <LoadingState />;

  return (
    <div>
      <p style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)', marginBottom: 20, lineHeight: 1.5 }}>
        {t('storage.description')}
      </p>
      <FormField label={t('storage.endpointUrl')} hint="e.g. http://localhost:9000">
        <FormInput value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="http://localhost:9000" />
      </FormField>
      <FormField label={t('storage.accessKey')} hint={t('storage.keepCurrentHint')}>
        <FormInput value={accessKey} onChange={(e) => setAccessKey(e.target.value)} placeholder="(unchanged)" autoComplete="off" />
      </FormField>
      <FormField label={t('storage.secretKey')} hint={t('storage.keepCurrentHint')}>
        <FormInput value={secretKey} onChange={(e) => setSecretKey(e.target.value)} type="password" placeholder="(unchanged)" autoComplete="off" />
      </FormField>
      <FormField label={t('storage.bucketName')}>
        <FormInput value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="azito-files" />
      </FormField>
      <FormField label={t('storage.region')}>
        <FormInput value={region} onChange={(e) => setRegion(e.target.value)} placeholder="us-east-1" />
      </FormField>
      <FormField label={t('storage.maxFileSize')}>
        <FormInput value={maxFileSize} onChange={(e) => setMaxFileSize(e.target.value)} type="number" min="1" max="500" />
      </FormField>
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-md)', cursor: 'pointer' }}>
          <label className="toggle">
            <input type="checkbox" checked={useSsl} onChange={(e) => setUseSsl(e.target.checked)} />
            <span className="toggle-slider" />
          </label>
          {t('storage.useSsl')}
        </label>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
        <Button variant="primary" onClick={handleSave} loading={saving} loadingLabel="Saving...">
          Save
        </Button>
        {status && (
          <span style={{ fontSize: 'var(--font-md)', color: status.type === 'success' ? 'var(--success)' : 'var(--danger)' }}>
            {status.message}
          </span>
        )}
      </div>
    </div>
  );
}
