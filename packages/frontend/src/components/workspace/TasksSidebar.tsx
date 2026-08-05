import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { IconButton } from '../ui/IconButton';
import { StatusDot } from '../StatusBadge';
import { BrailleSpinner, BlockedDot, FinishedIndicator } from '../ui/WindowActivityIndicator';
import { formatRelativeTime } from '../../utils/time';
import { useActiveWindowRows } from '../../hooks/useActiveWindowRows';
import { useBrowserGroups } from '../../hooks/useBrowserGroups';
import { buildTaskSidebarGroups, type TaskGroupKey, type TaskSidebarGroup, type TaskSidebarRow } from './taskSidebarModel';
import { listTaskChildren, type TaskChild } from './taskSidebarChildren';
import type { Task } from '../../pages/workspace/types';

const EXPAND_STORAGE_KEY = 'tasks-sidebar-expanded';

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
  const [expandedIds, setExpandedIds] = useState<Set<number>>(loadExpandedIds);
  const searchRef = useRef<HTMLInputElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const { rows: activityRows } = useActiveWindowRows();

  const groups = useMemo(
    () => buildTaskSidebarGroups(tasks, activityRows, query),
    [tasks, activityRows, query],
  );

  const totalVisible = groups.reduce((n, g) => n + g.rows.length, 0);
  const nonArchivedCount = tasks.filter((t) => t.status !== 'archived').length;

  const serverNames = useMemo(() => {
    const names = new Set<string>();
    for (const task of tasks) {
      if (task.serverName) names.add(task.serverName);
    }
    return Array.from(names);
  }, [tasks]);

  const browserGroups = useBrowserGroups(serverNames);

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

  function handleTreeKeyDown(e: React.KeyboardEvent) {
    const tree = treeRef.current;
    if (!tree) return;
    const items = Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (idx < 0) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        items[Math.min(idx + 1, items.length - 1)]?.focus();
        break;
      case 'ArrowUp':
        e.preventDefault();
        items[Math.max(idx - 1, 0)]?.focus();
        break;
      case 'ArrowRight': {
        e.preventDefault();
        const taskId = Number(items[idx].dataset.taskId);
        if (taskId && !expandedIds.has(taskId)) {
          toggleExpanded(taskId);
        } else {
          const next = items[idx + 1];
          if (next) next.focus();
        }
        break;
      }
      case 'ArrowLeft': {
        e.preventDefault();
        const taskId = Number(items[idx].dataset.taskId);
        if (taskId && expandedIds.has(taskId)) {
          toggleExpanded(taskId);
        } else {
          const parentItem = items[idx].closest('[role="group"]')?.closest('[role="treeitem"]') as HTMLElement | null;
          if (parentItem) parentItem.focus();
        }
        break;
      }
      case 'Enter':
        e.preventDefault();
        (items[idx] as HTMLElement).click();
        break;
      case 'Home':
        e.preventDefault();
        items[0]?.focus();
        break;
      case 'End':
        e.preventDefault();
        items[items.length - 1]?.focus();
        break;
    }
  }

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


      <div
        ref={treeRef}
        role="tree"
        aria-label={t('sidebar.title')}
        onKeyDown={handleTreeKeyDown}
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
  t: (key: string, opts?: Record<string, unknown>) => string;
}

function TaskRow({ row, expanded, toggleExpanded, onOpenTask, onOpenTaskWindow, onOpenTaskBrowser, browserGroups, t }: TaskRowProps) {
  const { task, activity } = row;
  const hasChildren = (task.windows && task.windows.length > 0) || false;

  const children = useMemo(
    () => (expanded ? listTaskChildren(task, browserGroups) : []),
    [expanded, task, browserGroups],
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
              child={child}
              taskId={task.id}
              taskTitle={task.title}
              onOpenTaskWindow={onOpenTaskWindow}
              onOpenTaskBrowser={onOpenTaskBrowser}
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
  t: (key: string, opts?: Record<string, unknown>) => string;
}

function ChildRow({ child, taskId, taskTitle, onOpenTaskWindow, onOpenTaskBrowser, t }: ChildRowProps) {
  if (child.kind === 'window') {
    const w = child.window;
    const label = w.label || w.tmuxTarget;
    return (
      <div
        role="treeitem"
        tabIndex={0}
        onClick={() => onOpenTaskWindow(taskId, taskTitle, { serverName: w.serverName, target: w.tmuxTarget })}
        className="row-hover"
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
        <Icon name="terminal" size={14} style={{ color: 'var(--text-dim)', flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        {w.isPrimary && (
          <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)' }}>
            primary
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      role="treeitem"
      tabIndex={0}
      onClick={() => onOpenTaskBrowser(taskId, taskTitle, { serverName: child.serverName, groupId: child.groupId })}
      className="row-hover"
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
