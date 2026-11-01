import { useTranslation } from 'react-i18next';
import { WindowIdChip } from '../ui/WindowIdChip';
import type { SearchItem } from '../../lib/globalSearch/searchIndex';

interface SearchResultRowProps {
  item: SearchItem;
  selected: boolean;
  status?: 'sleeping' | 'offline';
  onSelect: () => void;
  onOpen: () => void;
}

export function SearchResultRow({ item, selected, status, onSelect, onOpen }: SearchResultRowProps) {
  const { t } = useTranslation('navigation');
  return <div id={`search-${item.kind}-${item.id}`} role="option" aria-selected={selected} className="global-search-row" onMouseMove={onSelect} onClick={onOpen}>
    <span className="global-search-marker">{selected ? '›' : ''}</span>
    <span className="global-search-label"><strong>{item.title}</strong><small>{item.projectName}{item.kind === 'window' ? ` · ${item.window?.serverName}` : item.kind === 'task' ? ` · #${item.id} · ${item.task?.status}` : ''}{status ? ` · ${t(`globalSearch.${status}`)}` : ''}</small></span>
    {item.kind === 'window' && <WindowIdChip id={item.id} />}
  </div>;
}
