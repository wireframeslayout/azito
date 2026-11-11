import { useTranslation } from 'react-i18next';
import { statusLabelKey } from '../../lib/taskStatus';
import { Icon } from '../ui/Icon';
import { WindowIdChip } from '../ui/WindowIdChip';
import { BrailleSpinner, BlockedDot } from '../ui/WindowActivityIndicator';
import type { SearchItem } from '../../lib/globalSearch/searchIndex';

interface SearchResultRowProps {
  item: SearchItem;
  selected: boolean;
  status?: 'sleeping' | 'offline';
  activityStatus?: 'working' | 'blocked';
  onSelect: () => void;
  onOpen: () => void;
}

export function SearchResultRow({ item, selected, status, activityStatus, onSelect, onOpen }: SearchResultRowProps) {
  const { t } = useTranslation(['navigation', 'common']);
  const taskStatus = item.task?.status;
  const blocked = activityStatus === 'blocked' || taskStatus === 'phase_review' || taskStatus === 'waiting_input' || taskStatus === 'pending_approval';
  return <div id={`search-${item.kind}-${item.id}`} role="option" aria-selected={selected} className="global-search-row" onMouseMove={onSelect} onClick={onOpen}>
    <Icon name={item.kind === 'orchestrator' ? 'chip' : item.window ? 'terminal' : item.kind === 'task' ? 'tasks' : 'projects'} size={16} />
    {blocked ? <BlockedDot /> : item.active ? <BrailleSpinner /> : null}
    <span className="global-search-label">
      <strong>{item.title}</strong>
      <small>{item.kind === 'project' ? '' : item.projectName}{item.window ? `${item.projectName ? ' · ' : ''}${item.window.serverName}` : taskStatus ? ` · #${item.id} · ${t(`common:status.${statusLabelKey(taskStatus)}`)}` : ''}{status ? ` · ${t(`navigation:globalSearch.${status}`)}` : ''}</small>
    </span>
    {item.window && <WindowIdChip id={item.id} />}
    {selected && <kbd className="key-chip" aria-hidden="true">Enter</kbd>}
  </div>;
}
