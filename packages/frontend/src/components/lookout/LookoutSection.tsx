import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { LookoutItem } from '../../lib/lookoutSummary';
import { LookoutRow, type LookoutSummary } from './LookoutRow';
interface CommonProps { name: 'attention' | 'active' | 'finished'; items: LookoutItem[]; empty?: ReactNode; summaries?: ReadonlyMap<string, LookoutSummary> }
type Props = CommonProps & ({ onOpen: (item: LookoutItem) => void; renderItem?: never } | { renderItem: (item: LookoutItem) => ReactNode; onOpen?: never });
export function LookoutSection({ name, items, onOpen, renderItem, empty, summaries }: Props) {
  const { t } = useTranslation('lookout');
  return <section style={{ marginTop: 'var(--space-4)' }}><h3 style={{ margin: '0 0 var(--space-2)', color: 'var(--text-dim)', fontSize: 'var(--font-xs)' }}><span aria-hidden="true" style={{ display: 'inline-block', width: 'var(--space-2)', height: 'var(--space-2)', borderRadius: 'var(--radius-full)', background: name === 'attention' ? 'var(--warning)' : name === 'active' ? 'var(--accent)' : 'var(--success)', marginRight: 'var(--space-2)' }} />{t(`sections.${name}`)} <span>{items.length}</span></h3>{items.length ? items.map(item => renderItem ? renderItem(item) : <LookoutRow key={item.key} item={item} onOpen={onOpen!} summary={summaries?.get(item.key)} />) : empty ?? <p style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)' }}>{t('empty')}</p>}</section>;
}
