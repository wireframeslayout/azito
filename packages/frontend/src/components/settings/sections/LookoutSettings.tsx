import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiOk as request } from '../../../api/apiOk';
import { notifyLookoutSettingsChanged } from '../../../lib/lookoutSettingsEvents';
import { LOOKOUT_NOTIFY_INTERVAL_CHANGED, LOOKOUT_NOTIFY_INTERVAL_KEY, readLookoutNotifyInterval, writeLookoutNotifyInterval, type LookoutNotifyInterval } from '../../../lib/lookoutNotifyInterval';
import { Button, LoadingState, Notice, SegmentedToggle } from '../../ui';
import { ModelSelect } from '../../ui/ModelSelect';
import { InlineToggle } from '../../ui/InlineToggle';

type Provider = 'claude' | 'codex';
interface Settings { enabled: boolean; provider: Provider; model: string; updatedAt: string }
interface Probe { ok: boolean; cli: { found: boolean; version: string | null }; reason?: string; stage?: string }
interface Model { id: string; label: string }

export function LookoutSettings() {
  const { t } = useTranslation('settings');
  const [interval, setInterval] = useState<LookoutNotifyInterval>(readLookoutNotifyInterval);
  useEffect(() => {
    const onChange = (event: Event) => setInterval((event as CustomEvent<LookoutNotifyInterval>).detail);
    const onStorage = (event: StorageEvent) => { if (event.key === LOOKOUT_NOTIFY_INTERVAL_KEY || event.key === null) setInterval(readLookoutNotifyInterval()); };
    window.addEventListener(LOOKOUT_NOTIFY_INTERVAL_CHANGED, onChange);
    window.addEventListener('storage', onStorage);
    return () => { window.removeEventListener(LOOKOUT_NOTIFY_INTERVAL_CHANGED, onChange); window.removeEventListener('storage', onStorage); };
  }, []);
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
    catch { setProbe({ ok: false, cli: { found: false, version: null }, reason: 'failed', stage: 'summary' }); }
    finally { setProbing(false); }
  };
  return <section style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 'var(--space-4)', marginBottom: 'var(--space-4)', display: 'grid', gap: 'var(--space-3)' }}>
    <h3 style={{ fontSize: 'var(--font-base)', margin: 0 }}>{t('lookout.title')}</h3>
    <span>{t('lookout.interval')}</span>
    <SegmentedToggle wrap ariaLabel={t('lookout.interval')} value={interval} onChange={(value: LookoutNotifyInterval) => { setInterval(value); writeLookoutNotifyInterval(value); }} options={[{ value: 'immediate', label: t('lookout.intervalImmediate') }, { value: '5min', label: t('lookout.interval5min') }, { value: '15min', label: t('lookout.interval15min') }, { value: 'off', label: t('lookout.intervalOff') }]} />
    {error && <Notice tone="danger">{t('lookout.saveFailed')}</Notice>}
    {!settings || !models ? !error && <LoadingState /> : <>
      <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}><span>{t('lookout.enabled')}<br /><small style={{ color: 'var(--text-dim)' }}>{t('lookout.description')}</small></span><InlineToggle active={settings.enabled} title={t('lookout.enabled')} onClick={() => { setSettings({ ...settings, enabled: !settings.enabled }); setDirty(true); }}>{settings.enabled ? '✓' : ''}</InlineToggle></label>
      <span>{t('lookout.provider')}</span>
      <SegmentedToggle ariaLabel={t('lookout.provider')} disabled={!settings.enabled || saving} value={settings.provider} onChange={(provider: Provider) => { const model = models[provider].find(m => m.id === (provider === 'claude' ? 'haiku' : 'gpt-6-luna')) ?? models[provider][0]; if (model) { setSettings({ ...settings, provider, model: model.id }); setDirty(true); } }} options={[{ value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }]} />
      <span id="lookout-model-label">{t('lookout.model')}</span>
      <div role="group" aria-labelledby="lookout-model-label"><ModelSelect ariaLabel={t('lookout.model')} models={models[settings.provider]} value={settings.model} disabled={!settings.enabled || saving} onChange={model => { setSettings({ ...settings, model }); setDirty(true); }} onValidityChange={setValid} /></div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}><Button onClick={save} disabled={!valid || !settings.model} loading={saving} loadingLabel={t('lookout.saving')}>{t('lookout.save')}</Button><Button onClick={runProbe} disabled={!settings.enabled || saving || dirty} loading={probing} loadingLabel={t('lookout.probing')}>{t('lookout.probe')}</Button></div>
      {probe && <Notice tone={probe.ok ? 'success' : 'warning'} sub={!probe.ok && probe.stage ? t(`lookout.hints.${probe.stage}`) : undefined}>{probe.ok ? t('lookout.detected', { version: probe.cli.version }) : t(`lookout.reasons.${probe.reason ?? 'failed'}`)}</Notice>}
    </>}
  </section>;
}
