import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { apiWithStatus } from '../../../api/client';
import ConfirmDialog from '../../ConfirmDialog';
import { Button, Chip, LoadingState } from '../../ui';
import { Notice } from '../../ui/Notice';

type Policy = 'ask' | 'misao' | 'tmux';
interface MuxServer { name: string; defaultMux: 'tmux' | 'misao' }
interface Settings { mode: Policy; servers: MuxServer[] }
type ServerResult = 'updated' | 'failed';

const POLICIES: readonly Policy[] = ['ask', 'misao', 'tmux'];

const cardStyle: CSSProperties = { background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 20 };
const titleStyle: CSSProperties = { fontSize: 'var(--font-base)', fontWeight: 600, margin: '0 0 4px' };
const descriptionStyle: CSSProperties = { fontSize: 'var(--font-sm)', color: 'var(--text-dim)', margin: 0, lineHeight: 1.5 };

export default function TerminalSection() {
  const { t } = useTranslation('settings');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [results, setResults] = useState<Record<string, ServerResult>>({});

  const load = async (): Promise<void> => {
    setLoadFailed(false);
    try {
      const [policy, servers] = await Promise.all([
        apiWithStatus<{ mode: Policy }>('/settings/mux-switch'),
        apiWithStatus<MuxServer[]>('/settings/mux-switch/servers'),
      ]);
      if (policy.status !== 200 || servers.status !== 200) throw new Error('mux switch settings unavailable');
      setSettings({ mode: policy.body.mode, servers: servers.body });
    } catch {
      setLoadFailed(true);
    }
  };
  useEffect(() => { void load(); }, []);

  const save = async (policy: Policy): Promise<void> => {
    setSaving(true);
    setSaveFailed(false);
    try {
      const response = await apiWithStatus('/settings/mux-switch', { method: 'PUT', body: JSON.stringify({ mode: policy }) });
      if (response.status !== 200) throw new Error('mux switch settings not saved');
      setSettings((old) => old && { ...old, mode: policy });
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const changeDefaultsToMisao = async (targets: MuxServer[]): Promise<void> => {
    setUpdating(true);
    setResults({});
    for (const server of targets) {
      let result: ServerResult = 'failed';
      try {
        const response = await apiWithStatus(`/servers/${encodeURIComponent(server.name)}`, { method: 'PUT', body: JSON.stringify({ defaultMux: 'misao' }) });
        if (response.status === 200) result = 'updated';
      } catch { /* shown as failed for this server */ }
      setResults((old) => ({ ...old, [server.name]: result }));
    }
    setUpdating(false);
    await load();
  };

  if (!settings) {
    if (!loadFailed) return <LoadingState />;
    return <Notice tone="danger" action={<Button size="sm" onClick={() => void load()}>{t('terminal.retry')}</Button>}>{t('terminal.loadFailed')}</Notice>;
  }

  const tmuxServers = settings.servers.filter((server) => server.defaultMux === 'tmux');
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <fieldset style={{ ...cardStyle, margin: 0, minWidth: 0 }} disabled={saving}>
        <legend style={{ ...titleStyle, padding: 0, float: 'left', width: '100%' }}>{t('terminal.policy')}</legend>
        <p style={{ ...descriptionStyle, clear: 'both', marginBottom: 12 }}>{t('terminal.policyDescription')}</p>
        <div style={{ display: 'grid', gap: 4 }}>
          {POLICIES.map((policy) => (
            <label key={policy} className="row-hover" style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44, padding: '0 8px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--font-md)', cursor: saving ? 'not-allowed' : 'pointer' }}>
              <input type="radio" name="mux-switch-policy" checked={settings.mode === policy} onChange={() => void save(policy)} />
              {t(`terminal.${policy}`)}
            </label>
          ))}
        </div>
        <p style={descriptionStyle}>{t('terminal.autoAskDescription')}</p>
        {saveFailed && <Notice tone="danger" style={{ marginTop: 12 }}>{t('terminal.saveFailed')}</Notice>}
      </fieldset>

      <section style={cardStyle} aria-labelledby="terminal-defaults-title">
        <h3 id="terminal-defaults-title" style={titleStyle}>{t('terminal.defaults')}</h3>
        <p style={{ ...descriptionStyle, marginBottom: 12 }}>{t('terminal.defaultsDescription')}</p>
        {tmuxServers.length > 0 && <p style={descriptionStyle}>{t('terminal.defaultsCount', { count: tmuxServers.length })}</p>}
        {settings.servers.length === 0 ? (
          <p style={descriptionStyle}>{t('terminal.noServers')}</p>
        ) : (
          <>
            <ul style={{ listStyle: 'none', margin: '0 0 12px', padding: 0, display: 'grid', gap: 6 }} aria-live="polite">
              {settings.servers.map((server) => (
                <li key={server.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-sm)', minWidth: 0 }}>
                  <span style={{ fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{server.name}</span>
                  <Chip>{server.defaultMux}</Chip>
                  {results[server.name] && (
                    <Chip tone={results[server.name] === 'updated' ? 'green' : 'red'}>{t(results[server.name] === 'updated' ? 'terminal.updated' : 'terminal.updateFailed')}</Chip>
                  )}
                </li>
              ))}
            </ul>
            {tmuxServers.length === 0 ? (
              <p style={descriptionStyle}>{t('terminal.allMisaoDone')}</p>
            ) : (
              <Button variant="primary" size="sm" loading={updating} loadingLabel={t('terminal.updating')} onClick={() => setConfirming(true)}>
                {t('terminal.allMisao', { count: tmuxServers.length })}
              </Button>
            )}
          </>
        )}
      </section>

      <ConfirmDialog
        open={confirming}
        title={t('terminal.defaults')}
        message={t('terminal.confirmDefaults', { count: tmuxServers.length, mux: 'misao' })}
        confirmVariant="primary"
        onCancel={() => setConfirming(false)}
        onConfirm={() => { setConfirming(false); void changeDefaultsToMisao(tmuxServers); }}
      />
    </div>
  );
}
