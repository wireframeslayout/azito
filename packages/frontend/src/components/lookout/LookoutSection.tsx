import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { LookoutItem } from '../../lib/lookoutSummary';
import { LookoutRow } from './LookoutRow';
interface Props { name: 'attention' | 'active' | 'finished'; items: LookoutItem[]; onOpen: (item: LookoutItem) => void; renderItem?: (item: LookoutItem) => ReactNode; empty?: ReactNode }
export function LookoutSection({ name, items, onOpen, renderItem, empty }: Props) {
  const { t } = useTranslation('lookout');
  return <section style={{ marginTop: 'var(--space-4)' }}><h3 style={{ margin: '0 0 var(--space-2)', color: 'var(--text-dim)', fontSize: 'var(--font-xs)' }}><span aria-hidden="true" style={{ display: 'inline-block', width: 'var(--space-2)', height: 'var(--space-2)', borderRadius: 'var(--radius-full)', background: name === 'attention' ? 'var(--warning)' : name === 'active' ? 'var(--accent)' : 'var(--success)', marginRight: 'var(--space-2)' }} />{t(`sections.${name}`)} <span>{items.length}</span></h3>{items.length ? items.map(item => renderItem ? renderItem(item) : <LookoutRow key={item.key} item={item} onOpen={onOpen} />) : empty ?? <p style={{ color: 'var(--text-dim)', fontSize: 'var(--font-xs)' }}>{t('empty')}</p>}</section>;
}
