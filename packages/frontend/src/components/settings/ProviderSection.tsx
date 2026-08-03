import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { useApi } from '../../hooks/useApi';
import ConfirmDialog from '../ConfirmDialog';
import FormField from '../FormField';
import Modal from '../Modal';
import { FormInput, FormSelect, Button } from '../ui';

interface Provider {
  id: string; name: string; type: string; apiKey?: string; api_key?: string; baseUrl?: string; base_url?: string;
}

function maskKey(key?: string): string {
  if (!key) return 'none';
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

interface ProviderSectionProps {
  layout: 'inline' | 'modal';
  /** 外部からモーダル開閉を制御する場合に指定（layout="modal"のみ有効）。指定時は自前トリガーボタンを描画しない */
  open?: boolean;
  onClose?: () => void;
}

export default function ProviderSection({ layout, open, onClose }: ProviderSectionProps) {
  const { t } = useTranslation('settings');
  const { data: providers, loading, refresh } = useApi<Provider[]>('/providers');

  const [modalOpen, setModalOpen] = useState(false);
  const [provId, setProvId] = useState('');
  const [provName, setProvName] = useState('');
  const [provType, setProvType] = useState('openai');
  const [provKey, setProvKey] = useState('');
  const [provUrl, setProvUrl] = useState('');
  const [formError, setFormError] = useState('');
  const [addLoading, setAddLoading] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  const resetForm = useCallback(() => {
    setProvId(''); setProvName(''); setProvKey(''); setProvUrl(''); setProvType('openai'); setFormError('');
  }, []);

  const handleAdd = useCallback(async () => {
    if (!provId.trim() || !provName.trim()) {
      setFormError(t('providers.idAndNameRequired'));
      return;
    }
    setFormError('');
    setAddLoading(true);
    try {
      await api('/providers', { method: 'POST', body: JSON.stringify({
        id: provId.trim(), name: provName.trim(), type: provType,
        api_key: provKey.trim(), base_url: provUrl.trim() || null,
      }) });
      resetForm();
      refresh();
    } finally {
      setAddLoading(false);
    }
  }, [provId, provName, provType, provKey, provUrl, resetForm, refresh]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      await api(`/providers/${deleteTarget}`, { method: 'DELETE' });
      refresh();
    } finally {
      setDeleteLoading(false);
      setDeleteTarget(null);
    }
  }, [deleteTarget, refresh]);

  const handleTest = useCallback(async (pid: string) => {
    setTesting(pid);
    setTestResult((prev) => ({ ...prev, [pid]: t('providers.testing') }));
    try {
      const res = await api<{ ok?: boolean; error?: string }>(`/providers/${pid}/test`, { method: 'POST' });
      setTestResult((prev) => ({ ...prev, [pid]: res.ok ? t('providers.connectedSuccessfully') : res.error || 'Failed' }));
    } catch {
      setTestResult((prev) => ({ ...prev, [pid]: t('providers.connectionFailed') }));
    }
    setTesting(null);
  }, []);

  const providerList = providers || [];

  const listContent = (
    <div style={{ marginBottom: layout === 'inline' ? 32 : 12 }}>
      {layout === 'inline' && (
        <h3 style={{ fontSize: 'var(--font-base)', fontWeight: 600, marginBottom: 10, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {t('providers.configuredProviders')}
        </h3>
      )}
      {!providerList.length ? (
        <div style={{ color: 'var(--text-dim)', fontSize: 'var(--font-md)' }}>{t('providers.noProviders')}</div>
      ) : (
        <div>
          {providerList.map((p) => {
            const key = p.apiKey ?? p.api_key;
            return (
              <div key={p.id} style={{ padding: layout === 'inline' ? '12px 0' : '8px 0', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 'var(--font-md)' }}>
                  <b>{p.name}</b>
                  <span style={{ color: 'var(--text-dim)', marginLeft: 8 }}>({p.type})</span>
                  <span style={{ color: 'var(--text-dim)', marginLeft: 8 }}>Key: {maskKey(key)}</span>
                  {(p.baseUrl ?? p.base_url) && <span style={{ color: 'var(--text-dim)', marginLeft: 8 }}>{p.baseUrl ?? p.base_url}</span>}
                  {layout === 'inline' && testResult[p.id] && (
                    <span style={{ marginLeft: 12, fontSize: 'var(--font-sm)', color: testResult[p.id].includes('success') ? 'var(--success)' : testResult[p.id] === 'Testing...' ? 'var(--text-dim)' : 'var(--danger)' }}>
                      {testResult[p.id]}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {layout === 'inline' && (
                    <Button size="sm" onClick={() => handleTest(p.id)} loading={testing === p.id} loadingLabel="Testing...">
                      Test
                    </Button>
                  )}
                  <Button variant="danger" size="sm" onClick={() => setDeleteTarget(p.id)}>{t('common:actions.delete')}</Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  const formContent = (
    <div style={layout === 'inline' ? { marginTop: 8, paddingTop: 20, borderTop: '1px solid var(--border)' } : undefined}>
      {layout === 'inline' && (
        <h3 style={{ fontSize: 'var(--font-base)', fontWeight: 600, marginBottom: 16, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{t('providers.addProvider')}</h3>
      )}
      {layout === 'modal' && (
        <h3 style={{ fontSize: 'var(--font-base)', margin: '12px 0 8px' }}>{t('providers.addProvider')}</h3>
      )}
      <FormField label="ID" required error={formError && !provId.trim() ? formError : undefined}>
        <FormInput value={provId} onChange={(e) => { setProvId(e.target.value); setFormError(''); }} placeholder="e.g. openai, anthropic" />
      </FormField>
      <FormField label={t('providers.displayName')} required error={formError && provId.trim() && !provName.trim() ? formError : undefined}>
        <FormInput value={provName} onChange={(e) => { setProvName(e.target.value); setFormError(''); }} placeholder="e.g. OpenAI" />
      </FormField>
      <FormField label="Type">
        <FormSelect value={provType} onChange={(e) => setProvType(e.target.value)}>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="custom">Custom (OpenAI-compatible)</option>
        </FormSelect>
      </FormField>
      <FormField label="API Key">
        <FormInput value={provKey} onChange={(e) => setProvKey(e.target.value)} type="password" />
      </FormField>
      <FormField label={t('providers.baseUrl')}>
        <FormInput value={provUrl} onChange={(e) => setProvUrl(e.target.value)} placeholder="https://..." />
      </FormField>
      {layout === 'inline' && (
        <div style={{ marginTop: 16 }}>
          <Button variant="primary" onClick={handleAdd} loading={addLoading} loadingLabel={t('providers.adding')}>{t('providers.addProvider')}</Button>
        </div>
      )}
    </div>
  );

  const deleteDialog = (
    <ConfirmDialog
      open={deleteTarget !== null}
      title={t('providers.deleteProvider')}
      message={`Delete provider "${deleteTarget}"? This cannot be undone.`}
      onConfirm={handleDelete}
      onCancel={() => setDeleteTarget(null)}
      loading={deleteLoading}
      confirmLabel={t('common:actions.delete')}
    />
  );

  if (layout === 'inline') {
    if (loading) return null;
    return (
      <>
        {listContent}
        {formContent}
        {deleteDialog}
      </>
    );
  }

  const isControlled = open !== undefined;

  return (
    <>
      {!isControlled && <Button onClick={() => setModalOpen(true)}>Providers</Button>}
      <Modal
        title="LLM Providers"
        open={isControlled ? open : modalOpen}
        onClose={() => {
          if (isControlled) onClose?.();
          else setModalOpen(false);
          resetForm();
        }}
        actions={<Button variant="primary" onClick={handleAdd} loading={addLoading} loadingLabel={t('providers.adding')}>{t('providers.addProvider')}</Button>}
      >
        {listContent}
        {formContent}
      </Modal>
      {deleteDialog}
    </>
  );
}
