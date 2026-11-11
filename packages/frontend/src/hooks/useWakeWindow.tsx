import { useIsMobile } from './useIsMobile';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiWithStatus } from '../api/client';
import { Overlay, Button } from '../components/ui';
import { Icon } from '../components/ui/Icon';
import { BottomSheet } from '../components/ui/BottomSheet';
import { ModalContent } from '../components/Modal';
import { MOBILE_STATUS_BAR_HEIGHT } from '../lib/mobileChrome';

type Mux = 'tmux' | 'misao';
interface Plan { serverName?: string; currentMux: Mux; mode: 'ask' | Mux; misao: { hosted: boolean; available: boolean; reason?: string; version?: string }; shouldAsk: boolean; }
interface Pending { resolve: (mux: Mux | null) => void; title: string; explicit: boolean; serverName?: string; version?: string; }

export function useWakeWindow() {
  const { t } = useTranslation('common');
  const isMobile = useIsMobile();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState('');
  const choose = async (windowId: number, title: string, explicit = false): Promise<Mux | null> => {
    const { status, body } = await apiWithStatus<Plan>(`/windows/${windowId}/respawn-plan`);
    if (status !== 200) throw new Error(t('terminal.muxPlanFailed'));
    if (body.currentMux === 'misao') return 'misao';
    if (!body.shouldAsk && !explicit) return body.mode === 'misao' && body.misao.hosted ? 'misao' : 'tmux';
    setRemember(false);
    setError('');
    return new Promise((resolve) => setPending({ resolve, title, explicit, serverName: body.serverName, version: body.misao.version }));
  };
  const finish = async (mux: Mux) => {
    if (!pending) return;
    if (remember) {
      try {
        const result = await apiWithStatus('/settings/mux-switch', { method: 'PUT', body: JSON.stringify({ mode: mux }) });
        if (result.status !== 200) throw new Error();
      } catch { setError(t('terminal.muxSaveFailed')); return; }
    }
    pending.resolve(mux);
    setPending(null);
  };
  const cancel = () => { pending?.resolve(null); setPending(null); };
  const contents = <form style={{ paddingBottom: isMobile ? `${MOBILE_STATUS_BAR_HEIGHT}px` : undefined }} onSubmit={(event) => { event.preventDefault(); void finish('misao'); }}>
      <ModalContent titleId="mux-switch-title" title={t('terminal.muxSwitchTitle')} onClose={cancel} hideCancel actions={<div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row-reverse', gap: 'var(--space-2)', width: isMobile ? '100%' : undefined }}><button ref={confirmRef} data-initial-focus type="submit" className="btn btn-primary" style={{ minHeight: 44 }}>{t('terminal.muxUseMisao')}</button><Button variant="ghost" type="button" style={{ minHeight: 44 }} onClick={() => pending?.explicit ? cancel() : void finish('tmux')}>{t('terminal.muxKeepTmux')}</Button></div>}>
        <p style={{ display: 'flex', alignItems: 'start', gap: 'var(--space-2)', fontFamily: 'var(--font-prose)' }}><Icon name="terminal" size={16} /><span>{t('terminal.muxSwitchDescription', { title: pending?.title })}</span></p>
        {pending?.serverName && <p>{pending.serverName} · misao {pending.version ?? t('terminal.muxVersionUnknown')}</p>}
        <ul style={{ paddingInlineStart: 'var(--space-5)', listStyle: 'none', fontFamily: 'var(--font-prose)' }}>{(['muxBenefit1', 'muxBenefit2', 'muxBenefit3'] as const).map((benefit) => <li key={benefit} style={{ display: 'flex', gap: 'var(--space-2)' }}><Icon name="check" size={14} style={{ color: 'var(--success)', flexShrink: 0 }} />{t(`terminal.${benefit}`)}</li>)}</ul>
        {!pending?.explicit && <label><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /> {t('terminal.muxRemember')}</label>}
        <p role="status" aria-live="polite">{error}</p>
      </ModalContent>
    </form>;
  const dialog = isMobile
    ? <BottomSheet open={pending !== null} onClose={cancel} title={t('terminal.muxSwitchTitle')} hideTitle>{contents}</BottomSheet>
    : <Overlay open={pending !== null} onClose={cancel} labelledBy="mux-switch-title" initialFocusRef={confirmRef} maxWidth={480}>{contents}</Overlay>;
  return { choose, dialog };
}
