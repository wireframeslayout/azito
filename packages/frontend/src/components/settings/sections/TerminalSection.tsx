import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiWithStatus } from '../../../api/client';
import ConfirmDialog from '../../ConfirmDialog';
import { Button, LoadingState } from '../../ui';

type Policy = 'ask' | 'misao' | 'tmux';
interface Settings { policy: Policy; servers: { name: string; defaultMux: 'tmux' | 'misao' }[] }

export default function TerminalSection() {
  const { t } = useTranslation('settings');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmMux, setConfirmMux] = useState<'misao' | 'tmux' | null>(null);
  const [message, setMessage] = useState('');
  const [results, setResults] = useState<Record<string, string>>({});
  const load = async () => {
    try {
      const response = await apiWithStatus<Settings>('/settings/mux-switch');
      if (response.status !== 200) throw new Error();
      setSettings(response.body); setMessage('');
    } catch { setMessage(t('terminal.loadFailed')); }
  };
  useEffect(() => { void load(); }, []);
  const save = async (policy: Policy) => {
    setBusy(true); setMessage('');
    try {
      const response = await apiWithStatus('/settings/mux-switch', { method: 'PUT', body: JSON.stringify({ policy }) });
      if (response.status !== 200) throw new Error();
      setSettings((old) => old && { ...old, policy });
    } catch { setMessage(t('terminal.saveFailed')); }
    finally { setBusy(false); }
  };
  const updateServers = async (mux: 'misao' | 'tmux') => {
    if (!settings) return;
    setBusy(true); setResults({});
    for (const server of settings.servers) {
      try {
        const response = await apiWithStatus(`/servers/${encodeURIComponent(server.name)}`, { method: 'PUT', body: JSON.stringify({ defaultMux: mux }) });
        if (response.status !== 200) throw new Error();
        setResults((old) => ({ ...old, [server.name]: t('terminal.updated') }));
      } catch { setResults((old) => ({ ...old, [server.name]: t('terminal.updateFailed') })); }
    }
    setBusy(false);
    await load();
  };
  if (!settings) return message ? <div role="alert">{message} <Button onClick={() => void load()}>{t('terminal.retry')}</Button></div> : <LoadingState />;
  return <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
    <section><h2>{t('terminal.policy')}</h2><p>{t('terminal.policyDescription')}</p>
      {(['ask', 'misao', 'tmux'] as const).map((policy) => <label key={policy} style={{ display: 'block', margin: 'var(--space-2)' }}><input type="radio" name="mux-policy" checked={settings.policy === policy} disabled={busy} onChange={() => void save(policy)} /> {t(`terminal.${policy}`)}</label>)}
    </section>
    <section><h2>{t('terminal.defaults')}</h2><p>{t('terminal.defaultsDescription')}</p>
      {settings.servers.length === 0 ? <p>{t('terminal.noServers')}</p> : <><ul>{settings.servers.map((server) => <li key={server.name}>{server.name}: {server.defaultMux} {results[server.name]}</li>)}</ul><Button disabled={busy} onClick={() => setConfirmMux('misao')}>{t('terminal.allMisao')}</Button> <Button disabled={busy} onClick={() => setConfirmMux('tmux')}>{t('terminal.allTmux')}</Button></>}
    </section>
    <p role="status" aria-live="polite">{message}</p>
    <ConfirmDialog open={confirmMux !== null} title={t('terminal.defaults')} message={t('terminal.confirmDefaults', { count: settings.servers.length, mux: confirmMux })} confirmVariant="primary" onCancel={() => setConfirmMux(null)} onConfirm={() => { if (confirmMux) void updateServers(confirmMux); setConfirmMux(null); }} />
  </div>;
}
