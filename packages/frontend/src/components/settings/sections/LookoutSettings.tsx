import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiWithStatus } from '../../../api/client';
import { notifyLookoutSettingsChanged } from '../../../lib/lookoutSettingsEvents';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const { status, body } = await apiWithStatus<T>(path, options);
  if (status < 200 || status >= 300) throw new Error('Request failed');
  return body;
}
import { Button, LoadingState, Notice, SegmentedToggle } from '../../ui';
import { ModelSelect } from '../../ui/ModelSelect';

type Provider = 'claude' | 'codex';
interface Settings { enabled: boolean; provider: Provider; model: string; updatedAt: string }
interface Probe { ok: boolean; cli: { found: boolean; version: string | null }; reason?: string; hint?: string }
interface Model { id: string; label: string }

export function LookoutSettings() {
  const { t } = useTranslation('settings');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<Record<Provider, Model[]> | null>(null);
  const [error, setError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [valid, setValid] = useState(true);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    let cancelled = false;
    Promise.all([request<Settings>('/settings/lookout'), request<Model[]>('/workers/models/claude'), request<Model[]>('/workers/models/codex')])
      .then(([value, claude, codex]) => { if (!cancelled) { setSettings(value); setModels({ claude, codex }); } })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, []);
  const save = async () => {
    if (!settings) return;
    setSaving(true); setError(false); setProbe(null);
    try { setSettings(await request<Settings>('/settings/lookout', { method: 'PUT', body: JSON.stringify({ enabled: settings.enabled, provider: settings.provider, model: settings.model }) })); setDirty(false); notifyLookoutSettingsChanged(); }
    catch { setError(true); }
    finally { setSaving(false); }
  };
  const runProbe = async () => {
    setProbing(true); setProbe(null);
    try { setProbe(await request<Probe>('/settings/lookout/probe', { method: 'POST' })); }
    catch { setProbe({ ok: false, cli: { found: false, version: null }, reason: t('lookout.probeFailed') }); }
    finally { setProbing(false); }
  };
  return <section style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 'var(--space-4)', marginBottom: 'var(--space-4)', display: 'grid', gap: 'var(--space-3)' }}>
    <h3 style={{ fontSize: 'var(--font-base)', margin: 0 }}>{t('lookout.title')}</h3>
    {error && <Notice tone="danger">{t('lookout.saveFailed')}</Notice>}
    {!settings || !models ? !error && <LoadingState /> : <>
      <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}><span>{t('lookout.enabled')}<br /><small style={{ color: 'var(--text-dim)' }}>{t('lookout.description')}</small></span><input type="checkbox" checked={settings.enabled} onChange={e => { setSettings({ ...settings, enabled: e.target.checked }); setDirty(true); }} /></label>
      <span>{t('lookout.provider')}</span>
      <SegmentedToggle ariaLabel={t('lookout.provider')} disabled={!settings.enabled || saving} value={settings.provider} onChange={(provider: Provider) => { const model = models[provider][0]; if (model) { setSettings({ ...settings, provider, model: model.id }); setDirty(true); } }} options={[{ value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }]} />
      <span id="lookout-model-label">{t('lookout.model')}</span>
      <div role="group" aria-labelledby="lookout-model-label"><ModelSelect ariaLabel={t('lookout.model')} models={models[settings.provider]} value={settings.model} disabled={!settings.enabled || saving} onChange={model => { setSettings({ ...settings, model }); setDirty(true); }} onValidityChange={setValid} /></div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}><Button onClick={save} disabled={!valid || !settings.model} loading={saving} loadingLabel={t('lookout.saving')}>{t('lookout.save')}</Button><Button onClick={runProbe} disabled={!settings.enabled || saving || dirty} loading={probing} loadingLabel={t('lookout.probing')}>{t('lookout.probe')}</Button></div>
      {probe && <Notice tone={probe.ok ? 'success' : 'warning'} sub={probe.hint}>{probe.ok ? t('lookout.detected', { version: probe.cli.version }) : probe.reason || t('lookout.probeFailed')}</Notice>}
    </>}
  </section>;
}
