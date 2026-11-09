import { useTranslation } from 'react-i18next';
import { flushBatch, type PendingEvent } from '../../lib/lookoutBatch';

interface LookoutToastProps {
  batch: readonly (PendingEvent & { action?: 'mux' | 'firewall' })[];
  onOpen: () => void;
  onDismiss: () => void;
  onAction: (event: PendingEvent & { action?: 'mux' | 'firewall' }) => void;
}
export function LookoutToast({ batch, onOpen, onDismiss, onAction }: LookoutToastProps) {
  const { t } = useTranslation('lookout');
  const counts = flushBatch(batch);
  if (!counts) return null;
  return <div className="lookout-toast" role="status" aria-live="polite" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onDismiss(); } }}>
    <button type="button" className="lookout-toast-main" onClick={onOpen}>
      <strong>Lookout</strong>
      <span>{(['attention', 'finished', 'failed'] as const).filter(kind => counts[kind] > 0).map(kind => t(`toast.${kind}`, { count: counts[kind] })).join(' · ')}</span>
      <span className="lookout-toast-names">{counts.names.join(' · ')}</span>
    </button>
    <button type="button" className="lookout-toast-close" aria-label={t('toast.close')} onClick={onDismiss}>×</button>
    {batch.filter(event => event.action).map(event => <button key={event.key} type="button" className="lookout-toast-action" onClick={() => onAction(event)}>{event.title} →</button>)}
  </div>;
}
