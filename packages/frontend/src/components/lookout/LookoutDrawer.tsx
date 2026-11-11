import { useTranslation } from 'react-i18next';
import type { LookoutItem, LookoutSections } from '../../lib/lookoutSummary';
import { Button, IconButton, Notice } from '../ui';
import { Icon } from '../ui/Icon';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatRelativeTime } from '../../utils/time';
import { createPortal } from 'react-dom';
import { useModalOpen } from '../../hooks/useHotkeys';
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
  const { t, i18n } = useTranslation('lookout');
  const fetchedSummaries = useLookoutSummaries([...sections.attention, ...sections.active, ...sections.finished], open && !summaries);
  const displayedSummaries = summaries ?? fetchedSummaries;
  const [, setClock] = useState(0);
  useEffect(() => {
    if (!open || snapshotUpdatedAt == null) return;
    let interval: ReturnType<typeof setInterval> | undefined;
    const elapsed = Math.max(0, Date.now() - snapshotUpdatedAt);
    const timeout = setTimeout(() => {
      setClock(value => value + 1);
      interval = setInterval(() => setClock(value => value + 1), 60_000);
    }, 60_000 - elapsed % 60_000);
    return () => { clearTimeout(timeout); clearInterval(interval); };
  }, [open, snapshotUpdatedAt]);
  const ref = useRef<HTMLDivElement>(null);
  const modalOpen = useModalOpen();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const container = ref.current;
    let focusInside = true;
    const trackFocus = (event: FocusEvent) => { focusInside = container?.contains(event.target as Node) ?? false; };
    document.addEventListener('focusin', trackFocus);
    if (!container?.inert) container?.focus();
    return () => {
      document.removeEventListener('focusin', trackFocus);
      if (focusInside) previous?.focus();
    };
  }, [open]);
  if (!open) return null;
  return createPortal(<div ref={ref} role="dialog" aria-labelledby="lookout-title" inert={modalOpen} tabIndex={-1} className="overlay-panel" onKeyDown={(event) => {
    if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
  }} style={{ position: 'fixed', zIndex: 140, inset: '0 0 var(--status-bar-height) auto', width: 'min(100vw, calc(20 * var(--space-6)))', height: 'calc(100dvh - var(--status-bar-height))', borderRadius: 0, background: 'var(--bg-solid)', overflowY: 'auto' }}>
    <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)', flexWrap: 'wrap' }}><h2 id="lookout-title" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--font-lg)' }}><Icon name="watch" />{t('currentSituation')}</h2><span style={{ color: 'var(--floating-text)', fontSize: 'var(--font-xs)' }}>{snapshotUpdatedAt != null ? t('updated', { time: formatRelativeTime(snapshotUpdatedAt, i18n.language) }) : t('notUpdated')}</span><IconButton size="sm" onClick={onRetry} disabled={snapshotStatus === 'loading'} aria-label={t('refresh')} title={t('refresh')}><Icon name="refresh" /></IconButton><IconButton size="sm" onClick={onClose} aria-label={t('close')} title={t('close')}><Icon name="close" /></IconButton></header>
    <LookoutCounts counts={sections.counts} activityKnown={snapshotStatus === 'ready'} />
    {snapshotStatus === 'error' && <Notice tone="warning" action={<Button size="sm" onClick={onRetry}>{t('retry')}</Button>}>{t('loadError')}</Notice>}
    {snapshotStatus === 'loading' && <p role="status" style={{ color: 'var(--text-dim)' }}>{t('loading')}</p>}
    <LookoutSection name="attention" countKnown={snapshotStatus === 'ready'} items={sections.attention} onOpen={onOpenItem} summaries={displayedSummaries} empty={snapshotStatus === 'ready' ? t('emptyAttention') : false} />
    <LookoutSection name="active" countKnown={snapshotStatus === 'ready'} items={sections.active} onOpen={onOpenItem} summaries={displayedSummaries} empty={snapshotStatus === 'ready' ? t('emptyActive') : false} />
    <LookoutSection name="finished" countKnown={snapshotStatus === 'ready'} items={sections.finished} onOpen={onOpenItem} summaries={displayedSummaries} empty={snapshotStatus === 'ready' ? undefined : false} />
  </div>, document.body);
}
