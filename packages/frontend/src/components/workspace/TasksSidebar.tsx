import { isAttentionRow } from '../../lib/sortActiveWindowRows';
import type { ActivityTitleData } from '../../lib/windowDisplay';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { Notice } from '../ui/Notice';
import { useLongPress, longPressStyle } from '../../hooks/useLongPress';
import { useGlobalFocus } from '../../hooks/useGlobalFocus';
import { useOperationLinks } from '../../hooks/useOperationLinks';
import { handleTreeKeyDown } from '../../hooks/useTreeKeyboard';
import { IconButton } from '../ui/IconButton';
import { StatusDot } from '../StatusBadge';
import { BrailleSpinner, BlockedDot, FinishedIndicator } from '../ui/WindowActivityIndicator';
import { formatRelativeTime } from '../../utils/time';
import { useActiveWindowRows, type ActiveWindowRow } from '../../hooks/useActiveWindowRows';
import { useRecentTasks } from '../../hooks/useRecentTasks';
import { useBrowserGroups } from '../../hooks/useBrowserGroups';
import { buildTaskSidebarGroups, findWindowActivity, type TaskGroupKey, type TaskSidebarGroup, type TaskSidebarRow } from './taskSidebarModel';
import { listTaskChildren, taskChildWindowTitle, type TaskChild } from './taskSidebarChildren';
import type { Task, Window } from '../../pages/workspace/types';

const EXPAND_STORAGE_KEY = 'tasks-sidebar-expanded';
const WINDOW_EXPAND_STORAGE_KEY = 'tasks-sidebar-expanded-windows';

function loadWindowExpanded(): Record<string, boolean> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(WINDOW_EXPAND_STORAGE_KEY) || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([key, v]) => /^[1-9]\d*$/.test(key) && typeof v === 'boolean'));
  } catch { return {}; }
}

function loadExpandedIds(): Set<number> {
  try {
    const raw = localStorage.getItem(EXPAND_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.filter((v): v is number => typeof v === 'number'));
  } catch { /* best-effort */ }
  return new Set();
}

function saveExpandedIds(ids: Set<number>): void {
  try {
    localStorage.setItem(EXPAND_STORAGE_KEY, JSON.stringify(Array.from(ids)));
  } catch { /* best-effort */ }
}

interface TasksSidebarProps {
  titleData: ActivityTitleData;
  showWindowContextMenu?: (e: React.MouseEvent, w: Window) => void;
  showWindowContextMenuAt?: (x: number, y: number, w: Window) => void;
  tasks: Task[];
  loading?: boolean;
  onOpenTask: (taskId: number, title: string) => void;
  onOpenAllTasks: () => void;
  onCreateTask: () => void;
  onOpenTaskWindow: (taskId: number, taskTitle: string, terminal: { serverName: string; target: string }) => void;
  onOpenTaskBrowser: (taskId: number, taskTitle: string, browser: { serverName: string; groupId: string }) => void;
}

const GROUP_LABEL_KEYS: Record<TaskGroupKey, string> = {
  running: 'sidebar.groupRunning',
  finished: 'sidebar.groupFinished',
  recent: 'sidebar.groupRecent',
};

export default function TasksSidebar({
  titleData,
  showWindowContextMenu,
  showWindowContextMenuAt,
  tasks,
  loading,
  onOpenTask,
  onOpenAllTasks,
  onCreateTask,
  onOpenTaskWindow,
  onOpenTaskBrowser,
}: TasksSidebarProps) {
  const { t } = useTranslation('tasks');
  const [query, setQuery] = useState('');
  const { focus } = useGlobalFocus();
  const [expandedIds, setExpandedIds] = useState<Set<number>>(loadExpandedIds);
  const [windowExpanded, setWindowExpanded] = useState<Record<string, boolean>>(loadWindowExpanded);
  const toggleWindow = (id: number, current: boolean) => setWindowExpanded(previous => {
    const validIds = new Set(tasks.flatMap(task => (task.windows ?? []).map(window => String(window.id))));
    const next = { ...Object.fromEntries(Object.entries(previous).filter(([key]) => validIds.has(key))), [id]: !current };
    try { localStorage.setItem(WINDOW_EXPAND_STORAGE_KEY, JSON.stringify(next)); } catch { /* best-effort */ }
    return next;
  });
  const searchRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const { rows: allActivityRows } = useActiveWindowRows(titleData);
  const activityRows = allActivityRows.filter(isAttentionRow);
  const { openedAt } = useRecentTasks();

  const groups = useMemo(
    () => buildTaskSidebarGroups(tasks, activityRows, query, openedAt),
    [tasks, activityRows, query, openedAt],
  );

  const { parents, error: linksError } = useOperationLinks(loading ? [] : tasks.filter(task => task.status !== 'archived').map(task => task.id));

  useEffect(() => {
    if (loading) return;
    const validIds = new Set(tasks.flatMap(task => (task.windows ?? []).map(window => String(window.id))));
    setWindowExpanded(previous => {
      const entries = Object.entries(previous).filter(([key]) => validIds.has(key));
      if (entries.length === Object.keys(previous).length) return previous;
      const next = Object.fromEntries(entries);
      try { localStorage.setItem(WINDOW_EXPAND_STORAGE_KEY, JSON.stringify(next)); } catch { /* best-effort */ }
      return next;
    });
  }, [tasks, loading]);

  const totalVisible = groups.reduce((n, g) => n + g.rows.length, 0);
  const nonArchivedCount = tasks.filter((t) => t.status !== 'archived').length;

  const serverNames = useMemo(() => {
    const names = new Set<string>();
    for (const task of tasks) {
      if (task.serverName) names.add(task.serverName);
    }
    return Array.from(names);
  }, [tasks]);

  const { groups: browserGroups } = useBrowserGroups(serverNames);

  const toggleExpanded = useCallback((taskId: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      saveExpandedIds(next);
      return next;
    });
  }, []);

  useEffect(() => {
    function handleSlash(e: KeyboardEvent) {
      if (e.key === '/' && document.activeElement !== searchRef.current) {
        const tag = (document.activeElement as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    document.addEventListener('keydown', handleSlash);
    return () => document.removeEventListener('keydown', handleSlash);
  }, []);


  const isSearching = query.trim().length > 0;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      <div
        style={{
          fontSize: 'var(--font-xs)',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: 'var(--text-dim)',
          padding: '12px 12px 4px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}
      >
        <span>
          {t('sidebar.title')}{' '}
          <span
            style={{
              fontWeight: 400,
              fontSize: 'var(--font-2xs)',
              background: 'var(--bg)',
              padding: '1px 6px',
              borderRadius: 'var(--radius-md)',
            }}
          >
            {isSearching ? `${totalVisible} / ${nonArchivedCount}` : nonArchivedCount}
          </span>
        </span>
        <IconButton title={t('sidebar.newTask')} onClick={onCreateTask} size="sm">
          <Icon name="plus" size={14} />
        </IconButton>
      </div>


      <div style={{ padding: '4px 6px', flexShrink: 0 }}>
        <input
          ref={searchRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setQuery('');
              searchRef.current?.blur();
            }
          }}
          placeholder={t('sidebar.searchPlaceholder')}
          style={{
            width: '100%',
            padding: '6px 10px',
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text)',
            fontSize: 'var(--font-md)',
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
      </div>


      {linksError && <Notice tone="warning">{t('sidebar.operationLinksError')}</Notice>}
      <div
        ref={treeRef}
        role="tree"
        aria-label={t('sidebar.title')}
        onKeyDown={e => handleTreeKeyDown(e, treeRef.current, expandedIds, toggleExpanded, toggleWindow)}
        style={{ flex: 1, overflowY: 'auto', padding: '0 4px 4px' }}
      >
        {loading ? (
          <SkeletonRows />
        ) : totalVisible === 0 ? (
          <div style={{ padding: '16px 8px', fontSize: 'var(--font-sm)', color: 'var(--text-dim)', textAlign: 'center' }}>
            {isSearching ? t('sidebar.noSearchResults') : t('sidebar.noTasks')}
          </div>
        ) : (
          groups.map((group) => (
            <TaskGroup
              key={group.key}
              group={group}
              expandedIds={expandedIds}
              toggleExpanded={toggleExpanded}
              onOpenTask={onOpenTask}
              onOpenTaskWindow={onOpenTaskWindow}
              onOpenTaskBrowser={onOpenTaskBrowser}
              browserGroups={browserGroups}
              focusedTaskId={focus.taskId}
              focusedWindowId={focus.windowId}
              showWindowContextMenu={showWindowContextMenu}
              showWindowContextMenuAt={showWindowContextMenuAt}
              parents={parents}
              windowExpanded={windowExpanded}
              toggleWindow={toggleWindow}
              activityRows={activityRows}
              showGroupLabel={!isSearching}
              t={t}
            />
          ))
        )}
      </div>


      <button
        type="button"
        onClick={onOpenAllTasks}
        className="row-hover"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          width: 'calc(100% - 16px)',
          margin: '4px 8px 8px',
          padding: '7px 8px',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border)',
          background: 'none',
          color: 'var(--accent)',
          fontSize: 'var(--font-sm)',
          fontWeight: 500,
          cursor: 'pointer',
          flexShrink: 0,
        }}
      >
        {t('sidebar.allTasks')}
        <Icon name="chevron-right" size={14} />
      </button>
    </div>
  );
}

function SkeletonRows() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 8px',
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: 'var(--bg-elevated)',
              flexShrink: 0,
            }}
          />
          <span
            style={{
              flex: 1,
              height: 14,
              borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-elevated)',
            }}
          />
        </div>
      ))}
    </>
  );
}

interface TaskGroupProps {
  group: TaskSidebarGroup;
  expandedIds: Set<number>;
  toggleExpanded: (id: number) => void;
  onOpenTask: (taskId: number, title: string) => void;
  onOpenTaskWindow: (taskId: number, title: string, terminal: { serverName: string; target: string }) => void;
  onOpenTaskBrowser: (taskId: number, title: string, browser: { serverName: string; groupId: string }) => void;
  browserGroups: Record<string, import('../../hooks/useBrowserGroups').BrowserGroupInfo[]>;
  focusedTaskId: number | null;
  focusedWindowId: number | null;
  showWindowContextMenu?: (e: React.MouseEvent, w: Window) => void;
  showWindowContextMenuAt?: (x: number, y: number, w: Window) => void;
  parents: ReadonlyMap<number, number>;
  windowExpanded: Record<string, boolean>;
  toggleWindow: (id: number, current: boolean) => void;
  activityRows: ActiveWindowRow[];
  showGroupLabel: boolean;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

function TaskGroup({
  group,
  expandedIds,
  toggleExpanded,
  onOpenTask,
  onOpenTaskWindow,
  onOpenTaskBrowser,
  browserGroups,
  focusedTaskId,
  focusedWindowId,
  showWindowContextMenu,
  showWindowContextMenuAt,
  parents,
  windowExpanded,
  toggleWindow,
  activityRows,
  showGroupLabel,
  t,
}: TaskGroupProps) {
  return (
    <div>
      {showGroupLabel && (
        <div
          style={{
            fontSize: 'var(--font-2xs)',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            color: 'var(--text-dim)',
            padding: '10px 8px 2px',
          }}
        >
          {t(GROUP_LABEL_KEYS[group.key])}
        </div>
      )}
      {group.rows.map((row) => (
        <TaskRow
          key={row.task.id}
          row={row}
          expanded={expandedIds.has(row.task.id)}
          toggleExpanded={toggleExpanded}
          onOpenTask={onOpenTask}
          onOpenTaskWindow={onOpenTaskWindow}
          onOpenTaskBrowser={onOpenTaskBrowser}
          browserGroups={browserGroups}
          focusedTaskId={focusedTaskId}
          focusedWindowId={focusedWindowId}
          showWindowContextMenu={showWindowContextMenu}
          showWindowContextMenuAt={showWindowContextMenuAt}
          parents={parents}
          windowExpanded={windowExpanded}
          toggleWindow={toggleWindow}
          activityRows={activityRows}
          t={t}
        />
      ))}
    </div>
  );
}

interface TaskRowProps {
  row: TaskSidebarRow;
  expanded: boolean;
  toggleExpanded: (id: number) => void;
  onOpenTask: (taskId: number, title: string) => void;
  onOpenTaskWindow: (taskId: number, title: string, terminal: { serverName: string; target: string }) => void;
  onOpenTaskBrowser: (taskId: number, title: string, browser: { serverName: string; groupId: string }) => void;
  browserGroups: Record<string, import('../../hooks/useBrowserGroups').BrowserGroupInfo[]>;
  focusedTaskId: number | null;
  focusedWindowId: number | null;
  showWindowContextMenu?: (e: React.MouseEvent, w: Window) => void;
  showWindowContextMenuAt?: (x: number, y: number, w: Window) => void;
  parents: ReadonlyMap<number, number>;
  windowExpanded: Record<string, boolean>;
  toggleWindow: (id: number, current: boolean) => void;
  activityRows: ActiveWindowRow[];
  t: (key: string, opts?: Record<string, unknown>) => string;
}

function TaskRow({ row, expanded, toggleExpanded, onOpenTask, onOpenTaskWindow, onOpenTaskBrowser, browserGroups, focusedTaskId, focusedWindowId, showWindowContextMenu, showWindowContextMenuAt, parents, windowExpanded, toggleWindow, activityRows, t }: TaskRowProps) {
  const { task, activity } = row;
  const selectedWindowId = focusedTaskId === task.id ? focusedWindowId : null;
  const hasChildren = (task.windows && task.windows.length > 0) || false;

  const children = useMemo(
    () => (expanded ? listTaskChildren(task, browserGroups, parents) : []),
    [expanded, task, browserGroups, parents],
  );

  return (
    <div>
      <div
        role="treeitem"
        tabIndex={0}
        aria-expanded={hasChildren || expanded ? expanded : undefined}
        data-task-id={task.id}
        onClick={() => onOpenTask(task.id, task.title)}
        onKeyDown={(e) => {
          if (e.key === ' ') {
            e.preventDefault();
            toggleExpanded(task.id);
          }
        }}
        className="row-hover"
        title={task.title}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          padding: '5px 8px',
          borderRadius: 'var(--radius-md)',
          background: 'none',
          border: 'none',
          color: 'var(--text)',
          textAlign: 'left',
          cursor: 'pointer',
          fontSize: 'var(--font-md)',
        }}
      >
        <button
          type="button"
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation();
            toggleExpanded(task.id);
          }}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            color: 'var(--text-dim)',
            flexShrink: 0,
            width: 14,
          }}
          aria-hidden="true"
        >
          <Icon name="chevron-right" size={14} rotate={expanded ? 90 : 0} />
        </button>
        <StatusDot status={task.status} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {task.title}
        </span>
        {activity && <ActivityIndicator activity={activity} />}
        <span
          style={{
            fontSize: 'var(--font-2xs)',
            color: 'var(--text-dim)',
            background: 'var(--bg)',
            borderRadius: 'var(--radius-sm)',
            padding: '1px 5px',
            flexShrink: 0,
          }}
        >
          #{task.id}
        </span>
      </div>

      {expanded && children.length > 0 && (
        <div role="group" style={{ paddingLeft: 20 }}>
          {children.map((child) => (
            <ChildRow
              key={childKey(child)}
              subRows={child.kind === 'window' ? child.children.map(sub => <ChildRow key={sub.window.id} child={{ ...sub, children: [] }} isSubagent selectedWindowId={selectedWindowId} showWindowContextMenu={showWindowContextMenu} showWindowContextMenuAt={showWindowContextMenuAt} taskId={task.id} taskTitle={task.title} onOpenTaskWindow={onOpenTaskWindow} onOpenTaskBrowser={onOpenTaskBrowser} activity={findWindowActivity(activityRows, sub.window.serverName, sub.window.tmuxTarget)} activityRows={activityRows} windowExpanded={windowExpanded} toggleWindow={toggleWindow} t={t} />) : undefined}
              child={child}
              taskId={task.id}
              taskTitle={task.title}
              onOpenTaskWindow={onOpenTaskWindow}
              onOpenTaskBrowser={onOpenTaskBrowser}
              selectedWindowId={selectedWindowId}
              showWindowContextMenu={showWindowContextMenu}
              showWindowContextMenuAt={showWindowContextMenuAt}
              windowExpanded={windowExpanded}
              toggleWindow={toggleWindow}
              activityRows={activityRows}
              activity={child.kind === 'window' ? findWindowActivity(activityRows, child.window.serverName, child.window.tmuxTarget) : undefined}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function childKey(child: TaskChild): string {
  if (child.kind === 'window') return `w-${child.window.id}`;
  return `b-${child.serverName}/${child.groupId}`;
}

function ActivityIndicator({ activity }: { activity: import('../../hooks/useActiveWindowRows').ActiveWindowRow }) {
  if (activity.status === 'running') {
    if (activity.activityStatus === 'blocked') return <BlockedDot />;
    return <BrailleSpinner />;
  }
  if (activity.status === 'finished') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
        <FinishedIndicator />
        {activity.finishedAt != null && (
          <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--success)', whiteSpace: 'nowrap' }}>
            {formatRelativeTime(activity.finishedAt)}
          </span>
        )}
      </span>
    );
  }
  return null;
}

interface ChildRowProps {
  child: TaskChild;
  taskId: number;
  taskTitle: string;
  onOpenTaskWindow: (taskId: number, title: string, terminal: { serverName: string; target: string }) => void;
  onOpenTaskBrowser: (taskId: number, title: string, browser: { serverName: string; groupId: string }) => void;
  activity?: ActiveWindowRow;
  activityRows: ActiveWindowRow[];
  windowExpanded: Record<string, boolean>;
  toggleWindow: (id: number, current: boolean) => void;
  isSubagent?: boolean;
  subRows?: React.ReactNode;
  selectedWindowId?: number | null;
  showWindowContextMenu?: (e: React.MouseEvent, w: Window) => void;
  showWindowContextMenuAt?: (x: number, y: number, w: Window) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

function ChildRow({ child, taskId, taskTitle, onOpenTaskWindow, onOpenTaskBrowser, activity, activityRows, windowExpanded, toggleWindow, isSubagent, subRows, selectedWindowId, showWindowContextMenu, showWindowContextMenuAt, t }: ChildRowProps) {
  const bindLongPress = useLongPress();
  if (child.kind === 'window') {
    const w = child.window;
    const label = taskChildWindowTitle(w, taskTitle, activity);
    const isExpanded = windowExpanded[w.id] ?? child.children.some(c => findWindowActivity(activityRows, c.window.serverName, c.window.tmuxTarget)?.status === 'running');
    return (
      <>
      <div
        role="treeitem"
        data-window-id={w.id}
        aria-selected={w.id === selectedWindowId}
        onContextMenu={showWindowContextMenu ? e => { e.stopPropagation(); showWindowContextMenu(e, w); } : undefined}
        {...(showWindowContextMenuAt ? bindLongPress((x, y) => showWindowContextMenuAt(x, y, w)) : {})}
        aria-expanded={child.children.length ? isExpanded : undefined}
        onKeyDown={e => { if (e.target === e.currentTarget && e.key === ' ' && child.children.length) { e.preventDefault(); toggleWindow(w.id, isExpanded); } }}
        tabIndex={0}
        onClick={e => { e.stopPropagation(); onOpenTaskWindow(taskId, taskTitle, { serverName: w.serverName, target: w.tmuxTarget }); }}
        className={`row-hover task-sidebar-child${w.id === selectedWindowId ? ' row-selected' : ''}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '4px 8px',
          borderRadius: 'var(--radius-sm)',
          cursor: 'pointer',
          fontSize: 'var(--font-sm)',
          color: 'var(--text)',
          ...longPressStyle,
        }}
      >
        {child.children.length > 0 && <button className="task-sidebar-window-toggle" type="button" tabIndex={-1} aria-hidden="true" onClick={e => { e.stopPropagation(); toggleWindow(w.id, isExpanded); }} style={{ background: 'none', border: 0, color: 'var(--text-dim)', cursor: 'pointer' }}><Icon name="chevron-right" size={14} rotate={isExpanded ? 90 : 0} /></button>}
        <Icon name="terminal" size={14} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        {activity && <ActivityIndicator activity={activity} />}
        {isSubagent && <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)' }}>{t('sidebar.subagent')}</span>}
        <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)' }}>W-{w.id}</span>
        {w.isPrimary && (
          <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)' }}>
            primary
          </span>
        )}
      </div>
      {isExpanded && child.children.length > 0 && <div role="group" style={{ paddingLeft: 20 }}>{subRows}</div>}
      </>
    );
  }

  return (
    <div
      role="treeitem"
      tabIndex={0}
      onClick={() => onOpenTaskBrowser(taskId, taskTitle, { serverName: child.serverName, groupId: child.groupId })}
      className="row-hover task-sidebar-child"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 8px',
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
        fontSize: 'var(--font-sm)',
        color: 'var(--text)',
      }}
    >
      <Icon name="browser" size={14} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {child.groupId}
      </span>
      {child.pageCount != null && (
        <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)' }}>
          {t('sidebar.browserTabs', { count: child.pageCount })}
        </span>
      )}
    </div>
  );
}
