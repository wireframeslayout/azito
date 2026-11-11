import { windowKey } from '@azito/shared';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useHotkey } from '../../hooks/useHotkeys';
import { useOrchestrators } from '../../hooks/useOrchestrators';
import { useWorkspaceCatalog } from '../../hooks/useWorkspaceCatalog';
import { useCrossProjectNavigation } from '../../hooks/useCrossProjectNavigation';
import { useRecentTasks } from '../../hooks/useRecentTasks';
import { useProjectRail } from '../../hooks/useProjectRail';
import { useOptionalMaximizedWindow } from '../../hooks/useMaximizedWindow';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useVirtualKeyboard } from '../../hooks/useVirtualKeyboard';
import { useActiveWindowRows } from '../../hooks/useActiveWindowRows';
import { useSearchServerStatus } from '../../hooks/useSearchServerStatus';
import { recentItems } from '../../lib/globalSearch/recentItems';
import { buildSearchIndex, searchIndex, type SearchItem, type SearchKind } from '../../lib/globalSearch/searchIndex';
import { paths } from '../../paths';
import { findSessionWindow } from '../../lib/windowMatch';
import { buildWindowIndex } from '../../lib/windowDisplay';
import type { Session } from '../../pages/workspace/types';
import { SearchResultRow } from './SearchResultRow';
import { Overlay } from '../ui/Overlay';
import { IconButton } from '../ui/IconButton';
import { Icon } from '../ui/Icon';
import { Chip } from '../ui/Chip';
import { Notice } from '../ui/Notice';
import { LoadingState } from '../ui/LoadingState';
import { EmptyState } from '../ui/EmptyState';
import { SearchResultList } from '../ui/SearchResultList';

const Context = createContext<((fallbackFocusTo?: HTMLElement | null) => void) | null>(null);
export function useOpenGlobalSearch(): (fallbackFocusTo?: HTMLElement | null) => void {
  const open = useContext(Context);
  if (!open) throw new Error('GlobalSearchProvider is required');
  return open;
}

type Category = 'all' | SearchKind;
const defaultCategories: Category[] = ['all', 'window', 'orchestrator', 'task', 'project'];

export function GlobalSearchProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const [fallbackFocusTo, setFallbackFocusTo] = useState<HTMLElement | null>(null);
  useHotkey({ action: 'search.open', scope: 'global', when: 'not-editable', handler: () => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setFallbackFocusTo(null); setOpen(true); } });
  return <Context.Provider value={fallback => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setFallbackFocusTo(fallback ?? null); setOpen(true); }}>{children}{open && <GlobalSearchPalette returnFocusTo={opener.current} fallbackFocusTo={fallbackFocusTo} onClose={() => setOpen(false)} />}</Context.Provider>;
}

function resolveWindowStatus(item: SearchItem, unreachable: readonly string[], sessions: Record<string, Session[]>): 'sleeping' | 'offline' | undefined {
  const window = item.window;
  if (!window) return undefined;
  if (window.sleeping) return 'sleeping';
  if (unreachable.includes(window.serverName)) return 'offline';
  const listed = sessions[window.serverName];
  if (!listed) return undefined;
  const match = findSessionWindow(window, listed);
  return !match || match.session.stale ? 'offline' : undefined;
}

function GlobalSearchPalette({ onClose, fallbackFocusTo, returnFocusTo }: { onClose: () => void; fallbackFocusTo: HTMLElement | null; returnFocusTo: HTMLElement | null }) {
  const { t } = useTranslation('navigation');
  const { allProjects, allTasks, loading, error, refresh } = useWorkspaceCatalog();
  const orchestrators = useOrchestrators();
  const { openTask, openTerminal } = useCrossProjectNavigation();
  const { openedAt } = useRecentTasks();
  const rail = useProjectRail();
  const { rows } = useActiveWindowRows({ windowById: buildWindowIndex(allProjects, allTasks, null), taskById: new Map(allTasks.map(task => [task.id, task])) });
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const maximize = useOptionalMaximizedWindow();
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
  const windows = [...allProjects.flatMap(project => project.windows ?? []), ...allTasks.flatMap(task => task.windows ?? []), ...orchestrators.windows];
  const { sessions, failed, unreachable, retry } = useSearchServerStatus(windows);
  const runningRows = rows.filter(row => row.status === 'running');
  const activeTargets = new Set(runningRows.map(row => windowKey(row.serverName, row.target)));
  const activeIds = new Set(runningRows.flatMap(row => row.windowId == null ? [] : [row.windowId]));
  for (const window of windows) {
    if (activeTargets.has(windowKey(window.serverName, window.tmuxTarget))) activeIds.add(window.id);
  }
  const index = buildSearchIndex(allProjects, allTasks, openedAt, activeIds, sessions, orchestrators.windows);
  const categories = defaultCategories;
  const activeCategory = categories.includes(category) ? category : 'all';
  const matches = query.trim() ? searchIndex(index, query) : recentItems(index, rail.recentIds);
  const groups = categories.slice(1).map(kind => ({ kind: kind as SearchKind, items: matches.filter(item => item.kind === kind) }));
  const shownGroups = groups.filter(group => activeCategory === 'all' || group.kind === activeCategory).map(group => ({ ...group, shown: group.items.slice(0, activeCategory === 'all' ? 8 : 50) }));
  const shown = shownGroups.flatMap(group => group.shown);
  const current = Math.min(selected, Math.max(0, shown.length - 1));
  const currentId = shown[current] ? `search-${shown[current].kind}-${shown[current].id}` : undefined;
  useEffect(() => { if (currentId) document.getElementById(currentId)?.scrollIntoView?.({ block: 'nearest' }); }, [currentId]);
  const choose = (item: SearchItem) => {
    if (item.kind === 'orchestrator') navigate(paths.orchestration(item.id));
    else if (item.kind === 'task') openTask(item.id);
    else if (item.window) openTerminal({ serverName: item.window.serverName, target: item.window.tmuxTarget, windowId: item.id }, item.projectId);
    else { rail.touch(item.id); navigate(paths.workspace(item.id)); }
    onClose();
  };
  const changeCategory = (next: Category) => { setCategory(next); setSelected(0); };
  return <Overlay open onClose={onClose} fallbackFocusTo={fallbackFocusTo} labelledBy="global-search-title" surface="solid" initialFocusRef={input} toggleAction="search.open" maxWidth={680} style={{ padding: 0, overflow: 'hidden', ...(isMobile && viewportHeight ? { height: viewportHeight, maxHeight: viewportHeight } : {}) }}>
    <div className="global-search" onKeyDown={event => {
      if (event.target !== input.current) return;
      if (event.key === 'F6') { event.preventDefault(); closeButton.current?.focus(); }
      if (event.key === 'Tab') { event.preventDefault(); const i = categories.indexOf(activeCategory); changeCategory(categories[(i + (event.shiftKey ? categories.length - 1 : 1)) % categories.length]); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSelected(shown.length ? (current + (event.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length : 0); }
      if (event.key === 'Enter' && shown[current]) {
        event.preventDefault();
        const item = shown[current];
        if (event.shiftKey) {
          if (!isMobile && maximize && item.window && (item.kind === 'window' || item.kind === 'orchestrator')) { maximize.open(item.id, item.window, returnFocusTo?.isConnected ? returnFocusTo : fallbackFocusTo); onClose(); }
        } else choose(item);
      }
    }}>
      <header className="global-search-header"><h2 id="global-search-title" className="sr-only">{t('globalSearch.title')}</h2><Icon name="search" size={16} />
        <input ref={input} role="combobox" aria-label={t('globalSearch.title')} enterKeyHint="search" aria-expanded="true" aria-controls="global-search-results" aria-activedescendant={currentId} value={query} onChange={event => { setQuery(event.target.value); setSelected(0); }} placeholder={t('globalSearch.placeholder')} />
        <IconButton ref={closeButton} style={{ minWidth: 'calc(var(--space-5) + var(--space-6))', minHeight: 'calc(var(--space-5) + var(--space-6))' }} type="button" onClick={onClose} aria-label={t('globalSearch.close')}><kbd>Esc</kbd></IconButton>
      </header>
      <div className="global-search-tabs" role="tablist" aria-label={t('globalSearch.categories')}>
        {categories.map(kind => <button type="button" role="tab" aria-selected={activeCategory === kind} key={kind} onClick={() => changeCategory(kind)}>
          <Chip tone={activeCategory === kind ? 'accent' : 'default'}>{t(`globalSearch.${kind}`)} {kind === 'all' ? matches.length : groups.find(group => group.kind === kind)?.items.length}</Chip>
        </button>)}
      </div>
      {orchestrators.status === 'error' && <Notice tone="danger" action={<button onClick={orchestrators.refresh}>{t('globalSearch.retry')}</button>}>{t('globalSearch.orchestratorError')}</Notice>}
      {error && <Notice tone="danger" action={<button onClick={() => void refresh()}>{t('globalSearch.retry')}</button>}>{t('globalSearch.error')}</Notice>}
      {failed.length > 0 && <Notice tone="warning" action={<button onClick={retry}>{t('globalSearch.retry')}</button>}>{t('globalSearch.failed', { servers: failed.join(', ') })}</Notice>}
      {loading ? <LoadingState message={t('globalSearch.loading')} />
        : error && allProjects.length === 0 && allTasks.length === 0 ? null
        : shown.length === 0 ? <EmptyState title={query.trim() ? t('globalSearch.noResults', { query }) : t('globalSearch.empty')} /> : null}
      <SearchResultList id="global-search-results" label={t('globalSearch.results')} className="global-search-results" groupClassName="global-search-group" moreClassName="global-search-message"
        groups={shownGroups.map(group => ({ key: group.kind, label: t(`globalSearch.${group.kind}`), count: group.items.length, items: group.shown, more: t('globalSearch.more', { count: group.items.length - group.shown.length }) }))}
        renderItem={item => {
          const position = shown.indexOf(item);
          const activity = item.window ? runningRows.find(row => row.windowId === item.id || (row.serverName === item.window!.serverName && windowKey(row.serverName, row.target) === windowKey(item.window!.serverName, item.window!.tmuxTarget)))?.activityStatus : undefined;
          return <SearchResultRow key={`${item.kind}-${item.id}`} activityStatus={activity} item={item} selected={position === current} status={resolveWindowStatus(item, unreachable, sessions)} onSelect={() => setSelected(position)} onOpen={() => choose(item)} />;
        }} />
      <div role="status" aria-live="polite" className="sr-only">{t('globalSearch.count', { count: activeCategory === 'all' ? matches.length : groups.find(group => group.kind === activeCategory)?.items.length ?? 0 })}</div>
      <div className="global-search-footer key-hints">
        <span><kbd className="key-chip">Tab</kbd> {t('globalSearch.categoryHint')}</span>
        <span><kbd className="key-chip">↑ ↓</kbd> {t('globalSearch.selectHint')}</span>
        <span><kbd className="key-chip">Enter</kbd> {t('globalSearch.openHint')}</span>
        {!isMobile && maximize && <span><kbd className="key-chip">Shift + Enter</kbd> {t('globalSearch.maximizeHint')}</span>}
      </div>
    </div>
  </Overlay>;
}
