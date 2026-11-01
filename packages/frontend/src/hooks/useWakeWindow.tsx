import { useIsMobile } from './useIsMobile';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { apiWithStatus } from '../api/client';
import { Overlay, Button } from '../components/ui';
import { BottomSheet } from '../components/ui/BottomSheet';
import { ModalContent } from '../components/Modal';

type Mux = 'tmux' | 'misao';
interface Plan { mux: Mux; policy: 'ask' | Mux; shouldAsk: boolean; }
interface Pending { resolve: (mux: Mux | null) => void; title: string; explicit: boolean; }

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
    if (body.mux === 'misao') return 'misao';
    if (!body.shouldAsk && !explicit) return body.policy === 'misao' ? 'misao' : 'tmux';
    setRemember(false);
    setError('');
    return new Promise((resolve) => setPending({ resolve, title, explicit }));
  };
  const finish = async (mux: Mux) => {
    if (!pending) return;
    if (remember) {
      try {
        const result = await apiWithStatus('/settings/mux-switch', { method: 'PUT', body: JSON.stringify({ policy: mux }) });
        if (result.status !== 200) throw new Error();
      } catch { setError(t('terminal.muxSaveFailed')); return; }
    }
    pending.resolve(mux);
    setPending(null);
  };
  const cancel = () => { pending?.resolve(null); setPending(null); };
  const contents = <form onSubmit={(event) => { event.preventDefault(); void finish('misao'); }}>
      <ModalContent titleId="mux-switch-title" title={t('terminal.muxSwitchTitle')} onClose={cancel} hideCancel actions={<><Button type="button" onClick={cancel}>{t('actions.cancel')}</Button>{!pending?.explicit && <Button type="button" onClick={() => void finish('tmux')}>{t('terminal.muxKeepTmux')}</Button>}<button ref={confirmRef} data-initial-focus type="submit" className="btn btn-primary">{t('terminal.muxUseMisao')}</button></>}>
        <p>{t('terminal.muxSwitchDescription', { title: pending?.title })}</p>
        {!pending?.explicit && <label><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /> {t('terminal.muxRemember')}</label>}
        <p role="status" aria-live="polite">{error}</p>
      </ModalContent>
    </form>;
  const dialog = isMobile
    ? <BottomSheet open={pending !== null} onClose={cancel} title={t('terminal.muxSwitchTitle')}>{contents}</BottomSheet>
    : <Overlay open={pending !== null} onClose={cancel} labelledBy="mux-switch-title" initialFocusRef={confirmRef} maxWidth={480}>{contents}</Overlay>;
  return { choose, dialog };
}
