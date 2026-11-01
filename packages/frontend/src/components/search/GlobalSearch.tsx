import { windowKey } from '@azito/shared';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useHotkey } from '../../hooks/useHotkeys';
import { useWorkspaceCatalog } from '../../hooks/useWorkspaceCatalog';
import { useCrossProjectNavigation } from '../../hooks/useCrossProjectNavigation';
import { useNotificationChannel } from '../../hooks/useNotificationChannel';
import { useRecentTasks } from '../../hooks/useRecentTasks';
import { useProjectRail } from '../../hooks/useProjectRail';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useVirtualKeyboard } from '../../hooks/useVirtualKeyboard';
import { useActiveWindowRows } from '../../hooks/useActiveWindowRows';
import { fetchSessionListing, keepUnavailableKinds } from '../../lib/fetchServerSessions';
import { buildSearchIndex, searchIndex, type SearchItem, type SearchKind } from '../../lib/globalSearch/searchIndex';
import { paths } from '../../paths';
import { findSessionWindow } from '../../lib/windowMatch';
import type { Session } from '../../pages/workspace/types';
import { SearchResultRow } from './SearchResultRow';
import { Overlay } from '../ui/Overlay';

const Context = createContext<(() => void) | null>(null);
export function useOpenGlobalSearch(): () => void {
  const open = useContext(Context);
  if (!open) throw new Error('GlobalSearchProvider is required');
  return open;
}

type Category = 'all' | SearchKind;
const defaultCategories: Category[] = ['all', 'window', 'task', 'project'];

export function GlobalSearchProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  useHotkey({ action: 'search.open', scope: 'global', when: 'not-editable', handler: () => setOpen(true) });
  return <Context.Provider value={() => setOpen(true)}>{children}{open && <GlobalSearchPalette onClose={() => setOpen(false)} />}</Context.Provider>;
}

function GlobalSearchPalette({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('navigation');
  const { allProjects, allTasks, loading, error, refresh } = useWorkspaceCatalog();
  const { openTask, openTerminal } = useCrossProjectNavigation();
  const { openedAt } = useRecentTasks();
  const rail = useProjectRail();
  const { rows } = useActiveWindowRows();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const keyboardVisible = useVirtualKeyboard();
  const [viewportHeight, setViewportHeight] = useState<number | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!isMobile) return;
    if (!viewport) { setViewportHeight(window.innerHeight); return; }
    const update = () => setViewportHeight(viewport.height);
    update(); viewport.addEventListener('resize', update); viewport.addEventListener('scroll', update);
    return () => { viewport.removeEventListener('resize', update); viewport.removeEventListener('scroll', update); };
  }, [isMobile, keyboardVisible]);
  const input = useRef<HTMLInputElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category>('all');
  const [selected, setSelected] = useState(0);
  const [sessions, setSessions] = useState<Record<string, Session[]>>({});
  const [failed, setFailed] = useState<string[]>([]);
  const [loadingServers, setLoadingServers] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  useNotificationChannel({ onSessionsUpdated: () => setRefreshKey(value => value + 1) });
  const serverNames = [...new Set([...allProjects.flatMap(p => p.windows ?? []), ...allTasks.flatMap(task => task.windows ?? [])].map(w => w.serverName))].sort();
  const serverKey = JSON.stringify(serverNames);
  useEffect(() => {
    let cancelled = false;
    setLoadingServers(true);
    const names: string[] = JSON.parse(serverKey);
    setFailed(previous => previous.filter(name => names.includes(name)));
    if (names.length === 0) setLoadingServers(false);
    let remaining = names.length;
    for (const name of names) {
      void fetchSessionListing(name).then(listing => {
        if (cancelled) return;
        setSessions(previous => ({ ...previous, [name]: keepUnavailableKinds(previous[name], listing) }));
        setFailed(previous => listing.unavailable.length > 0 ? [...new Set([...previous, name])] : previous.filter(value => value !== name));
      }, () => {
        if (!cancelled) setFailed(previous => [...new Set([...previous, name])]);
      }).finally(() => {
        if (!cancelled && --remaining === 0) setLoadingServers(false);
      });
    }
    return () => { cancelled = true; };
  }, [serverKey, refreshKey]);
  const runningRows = rows.filter(row => row.status === 'running');
  const activeTargets = new Set(runningRows.map(row => windowKey(row.serverName, row.target)));
  const activeIds = new Set(runningRows.flatMap(row => row.windowId == null ? [] : [row.windowId]));
  for (const window of [...allProjects.flatMap(project => project.windows ?? []), ...allTasks.flatMap(task => task.windows ?? [])]) {
    if (activeTargets.has(windowKey(window.serverName, window.tmuxTarget))) activeIds.add(window.id);
  }
  const index = buildSearchIndex(allProjects, allTasks, openedAt, activeIds, sessions);
  const categories: Category[] = index.some(item => item.kind === 'orchestrator') ? ['all', 'window', 'orchestrator', 'task', 'project'] : defaultCategories;
  const recentRanks = new Map(rail.recentIds.map((id, i) => [id, rail.recentIds.length - i]));
  const activeCategory = categories.includes(category) ? category : 'all';
  const matches = query.trim() ? searchIndex(index, query) : index.filter(item => item.window ? item.active : item.kind === 'task' ? item.recent > 0 : recentRanks.has(item.id)).sort((a, b) => b.recent - a.recent || (b.kind === 'project' ? recentRanks.get(b.id) ?? 0 : 0) - (a.kind === 'project' ? recentRanks.get(a.id) ?? 0 : 0));
  const groups = categories.slice(1).map(kind => {
    const items = matches.filter(item => item.kind === kind);
    return { kind: kind as SearchKind, items: !query.trim() && kind === 'task' ? items.slice(0, 5) : items };
  });
  const shownGroups = groups.filter(group => activeCategory === 'all' || group.kind === activeCategory).map(group => ({ ...group, shown: group.items.slice(0, activeCategory === 'all' ? 8 : 50) }));
  const shown = shownGroups.flatMap(group => group.shown);
  const current = Math.min(selected, Math.max(0, shown.length - 1));
  const currentId = shown[current] ? `search-${shown[current].kind}-${shown[current].id}` : undefined;
  useEffect(() => { if (currentId) document.getElementById(currentId)?.scrollIntoView?.({ block: 'nearest' }); }, [currentId]);
  const choose = (item: SearchItem) => {
    if (item.kind === 'task') openTask(item.id);
    else if (item.window) openTerminal({ serverName: item.window.serverName, target: item.window.tmuxTarget, windowId: item.id }, item.projectId);
    else { rail.touch(item.id); navigate(paths.workspace(item.id)); }
    onClose();
  };
  const changeCategory = (next: Category) => { setCategory(next); setSelected(0); };
  return <Overlay open onClose={onClose} labelledBy="global-search-title" surface="solid" initialFocusRef={input} toggleAction="search.open" maxWidth={680} style={{ padding: 0, overflow: 'hidden', ...(isMobile && viewportHeight ? { height: viewportHeight, maxHeight: viewportHeight } : {}) }}>
    <div className="global-search" onKeyDown={event => {
      if (event.target !== input.current) return;
      if (event.key === 'F6') { event.preventDefault(); closeButton.current?.focus(); }
      if (event.key === 'Tab') { event.preventDefault(); const i = categories.indexOf(activeCategory); changeCategory(categories[(i + (event.shiftKey ? categories.length - 1 : 1)) % categories.length]); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelected(shown.length ? (current + (event.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length : 0); }
      if (event.key === 'Enter' && shown[current]) { event.preventDefault(); choose(shown[current]); }
    }}>
      <header className="global-search-header"><h2 id="global-search-title">{t('globalSearch.title')}</h2><button ref={closeButton} type="button" onClick={onClose} aria-label={t('globalSearch.close')}>×</button></header>
      <input ref={input} role="combobox" aria-label={t('globalSearch.title')} enterKeyHint="search" aria-expanded="true" aria-controls="global-search-results" aria-activedescendant={currentId} value={query} onChange={event => { setQuery(event.target.value); setSelected(0); }} placeholder={t('globalSearch.placeholder')} />
      <div className="global-search-tabs" role="tablist" aria-label={t('globalSearch.categories')}>{categories.map(kind => <button type="button" role="tab" aria-selected={activeCategory === kind} key={kind} onClick={() => changeCategory(kind)}>{t(`globalSearch.${kind}`)} <span>{kind === 'all' ? matches.length : groups.find(group => group.kind === kind)?.items.length}</span></button>)}</div>
      {error && <div role="alert" className="global-search-message">{t('globalSearch.error')} <button onClick={() => void refresh()}>{t('globalSearch.retry')}</button></div>}
      {failed.length > 0 && <div role="alert" className="global-search-message">{t('globalSearch.failed', { servers: failed.join(', ') })} <button onClick={() => setRefreshKey(value => value + 1)}>{t('globalSearch.retry')}</button></div>}
      <div id="global-search-results" role="listbox" aria-label={t('globalSearch.results')} className="global-search-results">
        {loading ? <div className="global-search-message" role="status">{t('globalSearch.loading')}</div> : error && allProjects.length === 0 && allTasks.length === 0 ? null : shown.length === 0 ? <div className="global-search-message" role="status">{query.trim() ? t('globalSearch.noResults', { query }) : t('globalSearch.empty')}</div> : shownGroups.map(group => group.shown.length > 0 && <section key={group.kind} role="group" aria-label={t(`globalSearch.${group.kind}`)}><div className="global-search-group">{t(`globalSearch.${group.kind}`)} · {group.items.length}</div>{group.shown.map(item => { const position = shown.indexOf(item); return <SearchResultRow key={`${item.kind}-${item.id}`} item={item} selected={position === current} status={item.window?.sleeping ? 'sleeping' : item.window && (failed.includes(item.window.serverName) || (sessions[item.window.serverName] && !findSessionWindow(item.window, sessions[item.window.serverName]))) ? 'offline' : undefined} onSelect={() => setSelected(position)} onOpen={() => choose(item)} />; })}{group.items.length > group.shown.length && <div className="global-search-message">{t('globalSearch.more', { count: group.items.length - group.shown.length })}</div>}</section>)}
      </div><div className="global-search-footer" aria-live="polite">{loadingServers ? `${t('globalSearch.loading')} · ` : ''}{t('globalSearch.count', { count: matches.length })}{shown[current] ? ` · ${shown[current].title}` : ''} · {t('globalSearch.hint')}</div>
    </div>
    <style>{` .global-search { display:flex; flex-direction:column; min-height:0; color:var(--text); } .global-search-header { display:flex; align-items:center; justify-content:space-between; padding:var(--space-3) var(--space-4); } .global-search-header h2 { margin:0; font-size:var(--font-md); } .global-search button { color:inherit; background:transparent; border:0; cursor:pointer; font:inherit; } .global-search button:hover { background:var(--bg-hover); } .global-search button:active { background:var(--bg-elevated); } .global-search button:focus-visible { outline:2px solid var(--accent); } .global-search input { margin:0 var(--space-4); padding:var(--space-3); border:1px solid var(--border); border-radius:var(--radius-md); background:var(--input-bg); color:var(--text); font:inherit; min-width:0; } .global-search input:focus-visible { outline:2px solid var(--accent); } .global-search-tabs { display:flex; gap:var(--space-1); overflow-x:auto; padding:var(--space-3) var(--space-4); border-bottom:1px solid var(--border); } .global-search-tabs button { flex-shrink:0; padding:var(--space-2); border-radius:var(--radius-sm); } .global-search-tabs button[aria-selected=true] { background:var(--bg-hover); font-weight:600; } .global-search-results { overflow-y:auto; min-height:0; max-height:50vh; } .global-search-group, .global-search-message, .global-search-footer { padding:var(--space-2) var(--space-4); color:var(--text-dim); font-size:var(--font-xs); } .global-search-row { display:flex; align-items:center; min-height:44px; cursor:pointer; padding:var(--space-2) var(--space-4); } .global-search-row[aria-selected=true] { background:var(--bg-hover); } .global-search-marker { width:var(--space-4); color:var(--accent); } .global-search-label { flex:1; display:flex; flex-direction:column; min-width:0; } .global-search-label strong, .global-search-label small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } .global-search-label small { color:var(--text-dim); } .global-search-footer { border-top:1px solid var(--border); } @media (max-width:768px) { .overlay-panel:has(.global-search) { width:100%; max-width:none !important; height:100dvh; max-height:100dvh; border-radius:0; padding-bottom:env(safe-area-inset-bottom) !important; } .global-search { height:100%; } .global-search-results { flex:1; max-height:none; } } `}</style>
  </Overlay>;
}
