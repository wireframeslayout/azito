import { useTranslation } from 'react-i18next';
import type { LookoutItem, LookoutSections } from '../../lib/lookoutSummary';
import { Button, Notice } from '../ui';
import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { LookoutCounts } from './LookoutCounts';
import { LookoutSection } from './LookoutSection';
import type { LookoutSummary } from './LookoutRow';
import { useLookoutSummaries } from '../../hooks/useLookoutSummaries';

interface Props {
  open: boolean;
  onClose: () => void;
  sections: LookoutSections;
  summaries?: ReadonlyMap<string, LookoutSummary>;
  snapshotStatus: 'loading' | 'ready' | 'error';
  snapshotUpdatedAt?: number | null;
  onRetry: () => void;
  onOpenItem: (item: LookoutItem) => void;
}
export function LookoutDrawer({ open, onClose, sections, summaries, snapshotStatus, snapshotUpdatedAt, onRetry, onOpenItem }: Props) {
  const { t } = useTranslation('lookout');
  const fetchedSummaries = useLookoutSummaries([...sections.attention, ...sections.active, ...sections.finished], open && !summaries);
  const displayedSummaries = summaries ?? fetchedSummaries;
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const container = ref.current;
    let focusInside = true;
    const trackFocus = (event: FocusEvent) => { focusInside = container?.contains(event.target as Node) ?? false; };
    document.addEventListener('focusin', trackFocus);
    container?.focus();
    return () => {
      document.removeEventListener('focusin', trackFocus);
      if (focusInside) previous?.focus();
    };
  }, [open]);
  if (!open) return null;
  return createPortal(<div ref={ref} role="dialog" aria-labelledby="lookout-title" tabIndex={-1} className="overlay-panel" onKeyDown={(event) => {
    if (event.key === 'Escape' && !event.defaultPrevented) { event.stopPropagation(); closeRef.current(); }
  }} style={{ position: 'fixed', zIndex: 140, inset: '0 0 0 auto', width: 'min(100vw, calc(20 * var(--space-6)))', height: '100dvh', borderRadius: 0, background: 'var(--bg-solid)', overflowY: 'auto' }}>
    <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)', flexWrap: 'wrap' }}><h2 id="lookout-title" style={{ margin: 0 }}>{t('currentSituation')}</h2><span style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)' }}>{snapshotUpdatedAt != null ? t('updated', { time: new Date(snapshotUpdatedAt).toLocaleTimeString() }) : t('notUpdated')}</span><Button size="sm" variant="ghost" onClick={onRetry} disabled={snapshotStatus === 'loading'}>{t('refresh')}</Button><Button size="sm" variant="ghost" onClick={onClose} aria-label={t('close')}>×</Button></header>
    <LookoutCounts counts={sections.counts} activityKnown={snapshotStatus === 'ready'} />
    {snapshotStatus === 'error' && <Notice tone="warning" action={<Button size="sm" onClick={onRetry}>{t('retry')}</Button>}>{t('loadError')}</Notice>}
    {snapshotStatus === 'loading' && <p role="status" style={{ color: 'var(--text-dim)' }}>{t('loading')}</p>}
    <LookoutSection name="attention" items={sections.attention} onOpen={onOpenItem} summaries={displayedSummaries} empty={<p>{t('emptyAttention')}</p>} />
    <LookoutSection name="active" countKnown={snapshotStatus === 'ready'} items={sections.active} onOpen={onOpenItem} summaries={displayedSummaries} empty={snapshotStatus === 'ready' ? <p>{t('emptyActive')}</p> : <></>} />
    <LookoutSection name="finished" items={sections.finished} onOpen={onOpenItem} summaries={displayedSummaries} />
  </div>, document.body);
}
