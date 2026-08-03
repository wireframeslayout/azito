import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/client';
import FormField from '../../FormField';
import { FormInput, Button, LoadingState, EmptyState } from '../../ui';

interface ResourceGuardSettingsData {
  enabled: boolean;
  memAvailablePercentMin: number;
  loadPerCoreMax: number;
}

interface ServerResourceEntry {
  serverName: string;
  type: 'local' | 'agent';
  measurement: { memAvailablePercent: number; loadPerCore: number } | null;
}

interface AllServersResourceData {
  enabled: boolean;
  memAvailablePercentMin: number;
  loadPerCoreMax: number;
  servers: ServerResourceEntry[];
}

export default function ResourceGuardSection() {
  const { t } = useTranslation('settings');
  const [enabled, setEnabled] = useState(true);
  const [memMin, setMemMin] = useState('10');
  const [loadMax, setLoadMax] = useState('2.0');
  const [servers, setServers] = useState<ServerResourceEntry[]>([]);
  const [thresholds, setThresholds] = useState<{ memAvailablePercentMin: number; loadPerCoreMax: number }>({
    memAvailablePercentMin: 10,
    loadPerCoreMax: 2.0,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  // 初回ロードが成功するまでは false。既定値のまま保存してサーバー設定を上書きしないよう、
  // 未初期化の間はフォームを描画せず Save も無効化する
  const [initialized, setInitialized] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [resourcesFetchFailed, setResourcesFetchFailed] = useState(false);
  const initializedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await api<ResourceGuardSettingsData>('/settings/resource-guard');
        if (cancelled) return;
        const isValidShape = typeof data.enabled === 'boolean'
          && typeof data.memAvailablePercentMin === 'number'
          && typeof data.loadPerCoreMax === 'number';
        if (!isValidShape) {
          if (!initializedRef.current) setLoadError(true);
        } else {
          if (!initializedRef.current) {
            setEnabled(data.enabled);
            setMemMin(String(data.memAvailablePercentMin));
            setLoadMax(String(data.loadPerCoreMax));
            initializedRef.current = true;
            setInitialized(true);
          }
          setLoadError(false);
        }
      } catch {
        if (!cancelled && !initializedRef.current) setLoadError(true);
      }
      if (!cancelled) setLoading(false);
    };
    load();
    const timer = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const loadServers = async () => {
      // 前回のリクエストが完了していない間は今回の実行をスキップする（重複 in-flight 防止）
      if (inFlight) return;
      inFlight = true;
      try {
        const data = await api<AllServersResourceData>('/servers/resources');
        if (cancelled) return;
        const isValidShape = Array.isArray(data.servers)
          && typeof data.memAvailablePercentMin === 'number'
          && typeof data.loadPerCoreMax === 'number';
        if (!isValidShape) throw new Error('invalid /servers/resources response shape');
        setServers(data.servers ?? []);
        setThresholds({
          memAvailablePercentMin: data.memAvailablePercentMin,
          loadPerCoreMax: data.loadPerCoreMax,
        });
        setResourcesFetchFailed(false);
      } catch {
        // 実測値取得の失敗は既存フォーム操作を妨げないが、前回値が現在値のように
        // 見えないよう注記を表示する
        if (!cancelled) setResourcesFetchFailed(true);
      } finally {
        inFlight = false;
      }
    };
    loadServers();
    const timer = setInterval(loadServers, 30000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const handleSave = useCallback(async () => {
    const memValue = parseFloat(memMin);
    const loadValue = parseFloat(loadMax);
    if (isNaN(memValue) || memValue < 0 || memValue > 100) {
      setStatus({ type: 'error', message: t('resourceGuard.memMinRange') });
      return;
    }
    if (isNaN(loadValue) || loadValue <= 0) {
      setStatus({ type: 'error', message: t('resourceGuard.loadMaxRange') });
      return;
    }
    setSaving(true);
    setStatus(null);
    try {
      const res = await api<{ ok?: boolean; error?: string }>('/settings/resource-guard', {
        method: 'PUT',
        body: JSON.stringify({ enabled, memAvailablePercentMin: memValue, loadPerCoreMax: loadValue }),
      });
      if (res.ok) {
        setStatus({ type: 'success', message: 'Settings saved' });
        setThresholds({ memAvailablePercentMin: memValue, loadPerCoreMax: loadValue });
      } else {
        setStatus({ type: 'error', message: res.error || 'Save failed' });
      }
    } catch (err: unknown) {
      setStatus({ type: 'error', message: (err as Error).message });
    } finally {
      setSaving(false);
      setTimeout(() => setStatus(null), 4000);
    }
  }, [enabled, memMin, loadMax]);

  if (loading) return <LoadingState />;
  if (loadError && !initialized) {
    return <EmptyState title={t('resourceGuard.loadFailed')} description={t('resourceGuard.loadFailedDescription')} />;
  }

  const { memAvailablePercentMin, loadPerCoreMax } = thresholds;

  return (
    <div>
      <p style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)', marginBottom: 20, lineHeight: 1.5 }}>
        {t('resourceGuard.description')}
      </p>
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-md)', cursor: 'pointer' }}>
          <label className="toggle">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span className="toggle-slider" />
          </label>
          {t('resourceGuard.enableCheck')}
        </label>
      </div>
      <FormField label={t('resourceGuard.memMinLabel')} hint={t('resourceGuard.memMinHint')}>
        <FormInput value={memMin} onChange={(e) => setMemMin(e.target.value)} type="number" min="0" max="100" step="1" disabled={!enabled} />
      </FormField>
      <FormField label={t('resourceGuard.loadMaxLabel')} hint={t('resourceGuard.loadMaxHint')}>
        <FormInput value={loadMax} onChange={(e) => setLoadMax(e.target.value)} type="number" min="0.1" step="0.1" disabled={!enabled} />
      </FormField>
      {servers.length > 0 && (
        <div style={{
          marginBottom: 16, background: 'var(--bg-card)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)', overflow: 'hidden',
        }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 16,
            padding: '8px 14px', fontSize: 'var(--font-xs)', color: 'var(--text-dim)',
            borderBottom: '1px solid var(--border)',
          }}>
            <span>{t('resourceGuard.server')}</span>
            <span>{t('resourceGuard.freeMemory')}</span>
            <span>{t('resourceGuard.loadPerCore')}</span>
          </div>
          {servers.map((s) => {
            const memExceeded = s.measurement != null && s.measurement.memAvailablePercent < memAvailablePercentMin;
            const loadExceeded = s.measurement != null && s.measurement.loadPerCore > loadPerCoreMax;
            return (
              <div
                key={s.serverName}
                style={{
                  display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 16,
                  padding: '8px 14px', fontSize: 'var(--font-sm)', fontVariantNumeric: 'tabular-nums',
                  alignItems: 'center',
                }}
              >
                <span>{s.serverName} <span style={{ color: 'var(--text-dim)' }}>({s.type})</span></span>
                {s.measurement ? (
                  <>
                    <span style={{ color: memExceeded ? 'var(--danger)' : 'var(--success)', textAlign: 'right' }}>
                      {s.measurement.memAvailablePercent.toFixed(1)}%
                    </span>
                    <span style={{ color: loadExceeded ? 'var(--danger)' : 'var(--success)', textAlign: 'right' }}>
                      {s.measurement.loadPerCore.toFixed(2)}
                    </span>
                  </>
                ) : (
                  <span style={{ color: 'var(--text-dim)', gridColumn: '2 / span 2', textAlign: 'right' }}>
                    {t('resourceGuard.notMeasurable')}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {resourcesFetchFailed && (
        <p style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginTop: -8, marginBottom: 16 }}>
          {t('resourceGuard.resourcesFetchFailed')}
        </p>
      )}
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
