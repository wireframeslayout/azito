import type { ReactNode } from 'react';

interface Group<T> { key: string; label: string; count: number; items: T[]; more: string; }
interface Props<T> {
  id: string;
  label: string;
  groups: Group<T>[];
  renderItem: (item: T) => ReactNode;
}

export function SearchResultList<T>({ id, label, groups, renderItem }: Props<T>) {
  return <div id={id} role="listbox" aria-label={label} className="global-search-results">
    {groups.filter(group => group.items.length > 0).map(group => <div role="group" aria-labelledby={`${id}-${group.key}`} key={group.key}>
      <div id={`${id}-${group.key}`} role="presentation" className="global-search-group">{group.label} · {group.count}</div>
      {group.items.map(renderItem)}
      {group.count > group.items.length && <div role="presentation" className="global-search-message">{group.more}</div>}
    </div>)}
  </div>;
}
