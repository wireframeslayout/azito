import { useTranslation } from 'react-i18next';
import type { LookoutItem, LookoutSections } from '../../lib/lookoutSummary';
import { Button, Notice } from '../ui';
import { Overlay } from '../ui/Overlay';
import { LookoutCounts } from './LookoutCounts';
import { LookoutSection } from './LookoutSection';

interface Props {
  open: boolean;
  onClose: () => void;
  sections: LookoutSections;
  snapshotStatus: 'loading' | 'ready' | 'error';
  onRetry: () => void;
  onOpenItem: (item: LookoutItem) => void;
}
export function LookoutDrawer({ open, onClose, sections, snapshotStatus, onRetry, onOpenItem }: Props) {
  const { t } = useTranslation('lookout');
  return <Overlay open={open} onClose={onClose} labelledBy="lookout-title" surface="solid" maxWidth="min(100vw, 480px)" maxHeight="100dvh" style={{ position: 'fixed', inset: '0 0 0 auto', height: '100dvh', borderRadius: 0, padding: 'var(--space-5)', overflowY: 'auto' }}>
    <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)' }}><h2 id="lookout-title" style={{ margin: 0 }}>{t('title')}</h2><Button size="sm" variant="ghost" onClick={onClose} aria-label={t('close')}>×</Button></header>
    <LookoutCounts counts={sections.counts} />
    {snapshotStatus === 'error' && <Notice tone="warning" action={<Button size="sm" onClick={onRetry}>{t('retry')}</Button>}>{t('loadError')}</Notice>}
    {snapshotStatus === 'loading' && <p role="status" style={{ color: 'var(--text-dim)' }}>{t('loading')}</p>}
    <LookoutSection name="attention" items={sections.attention} onOpen={onOpenItem} />
    <LookoutSection name="active" items={sections.active} onOpen={onOpenItem} />
    <LookoutSection name="finished" items={sections.finished} onOpen={onOpenItem} />
  </Overlay>;
}
