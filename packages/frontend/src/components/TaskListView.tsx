import { useState } from 'react';
import { useIsMobile } from '../hooks/useIsMobile';
import { StatusDot, StatusBadge } from './StatusBadge';
import { timeAgo } from '../utils/time';
import { useGlobalFocus } from '../hooks/useGlobalFocus';
import TaskKanbanBoard from './TaskKanbanBoard';
import { EmptyState } from './ui';
import TaskRefBadges from './TaskRefBadges';
import { Button } from './ui';
import { Icon } from './ui/Icon';
import { useTranslation } from 'react-i18next';

interface Task {
  id: number;
  title: string;
  description?: string;
  status: string;
  currentPhase?: string | null;
  projectId: number;
  unitId: number | null;
  priority: number;
  createdAt: string;
  sourceRef?: string | null;
  source?: 'local' | 'github' | 'gitlab';
  prUrl?: string | null;
  windows?: Array<{ sleeping?: boolean }>;
}

interface Project {
  id: number;
  name: string;
}

interface Unit {
  id: number;
  name: string;
}

type ViewMode = 'list' | 'kanban';

const VIEW_MODE_KEY = 'task-list-view-mode';

interface TaskListViewProps {
  tasks: Task[];
  projects: Project[];
  units: Unit[];
  showProjectColumn: boolean;
  onTaskClick: (task: Task) => void;
  onExecute: (taskId: number, unitId: number | null) => void;
  onStop: (taskId: number) => void;
  headerRight?: React.ReactNode;
}

function ListIcon({ active }: { active: boolean }) {
  return (
    <span style={{ display: 'inline-flex', color: active ? 'var(--accent)' : 'var(--text-dim)' }}>
      <Icon name="list" size={16} />
    </span>
  );
}

function KanbanIcon({ active }: { active: boolean }) {
  return (
    <span style={{ display: 'inline-flex', color: active ? 'var(--accent)' : 'var(--text-dim)' }}>
      <Icon name="kanban" size={16} />
    </span>
  );
}

export default function TaskListView({
  tasks,
  projects,
  units,
  showProjectColumn,
  onTaskClick,
  onExecute,
  onStop,
  headerRight,
}: TaskListViewProps) {
  const { isFocusedTask } = useGlobalFocus();
  const isMobile = useIsMobile();
  const { t } = useTranslation(['tasks', 'common']);
  // PageHeader / PageBody と水平ジオメトリを揃える（PC 20px / SP 12px）
  const hPad = isMobile ? 12 : 20;

  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = localStorage.getItem(VIEW_MODE_KEY);
    return saved === 'kanban' ? 'kanban' : 'list';
  });

  const toggleView = (mode: ViewMode) => {
    setViewMode(mode);
    localStorage.setItem(VIEW_MODE_KEY, mode);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: `12px ${hPad}px`,
        flexShrink: 0,
        gap: 12,
        flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            onClick={() => toggleView('list')}
            title={t('list.listView')}
            className="icon-btn"
            style={{
              background: viewMode === 'list' ? 'var(--bg-hover)' : 'none',
              border: '1px solid',
              borderColor: viewMode === 'list' ? 'var(--accent)' : 'var(--border)',
              padding: '4px 6px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <ListIcon active={viewMode === 'list'} />
          </button>
          <button
            onClick={() => toggleView('kanban')}
            title={t('list.kanbanView')}
            className="icon-btn"
            style={{
              background: viewMode === 'kanban' ? 'var(--bg-hover)' : 'none',
              border: '1px solid',
              borderColor: viewMode === 'kanban' ? 'var(--accent)' : 'var(--border)',
              padding: '4px 6px',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <KanbanIcon active={viewMode === 'kanban'} />
          </button>
        </div>
        {headerRight && <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{headerRight}</div>}
      </div>

      <div className="mobile-scroll-inset" style={{ flex: 1, overflow: 'auto', padding: `0 ${hPad}px 24px` }}>
        {tasks.length === 0 ? (
          <EmptyState title={t('list.noTasks')} description={t('list.noTasksDescription')} />
        ) : viewMode === 'kanban' ? (
          <TaskKanbanBoard
            tasks={tasks}
            projects={projects}
            units={units}
            showProjectColumn={showProjectColumn}
            onTaskClick={onTaskClick}
            onExecute={onExecute}
            onStop={onStop}
          />
        ) : (
          <table className="data-table" style={{ minWidth: 600 }}>
            <thead>
              <tr>
                {[
                  { key: 'status', label: t('list.status') },
                  { key: 'title', label: t('list.title') },
                  ...(showProjectColumn ? [{ key: 'project', label: t('list.project') }] : []),
                  { key: 'unit', label: t('list.unit') },
                  { key: 'priority', label: t('list.priority') },
                  { key: 'created', label: t('list.created') },
                  { key: 'actions', label: '' },
                ].map((h) => (
                  <th key={h.key}>{h.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const proj = projects.find((p) => p.id === task.projectId);
                const unit = units.find((u) => u.id === task.unitId);
                return (
                  <tr
                    key={task.id}
                    onClick={() => onTaskClick(task)}
                    className={isFocusedTask(task.id) ? 'row-selected' : undefined}
                    style={{ cursor: 'pointer' }}
                  >
                    <td>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <StatusDot status={task.status} />
                        <StatusBadge status={task.status} currentPhase={task.currentPhase} />
                      </span>
                    </td>
                    <td>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <TaskRefBadges taskId={task.id} sourceRef={task.sourceRef} source={task.source} prUrl={task.prUrl} />
                        {task.windows?.some(w => w.sleeping) && !task.windows?.some(w => !w.sleeping) && (
                          <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)', flexShrink: 0 }}>🌙</span>
                        )}
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</span>
                      </span>
                    </td>
                    {showProjectColumn && (
                      <td>{proj ? proj.name : '—'}</td>
                    )}
                    <td>{unit ? unit.name : '—'}</td>
                    <td>
                      {task.priority > 0 ? <span style={{ color: 'var(--warning)' }}>P{task.priority}</span> : t('common:priority.normal')}
                    </td>
                    <td style={{ color: 'var(--text-dim)' }}>{timeAgo(task.createdAt)}</td>
                    <td>
                      {task.status === 'open' && (
                        <Button variant="primary" size="sm" onClick={(e) => { e.stopPropagation(); onExecute(task.id, task.unitId); }}>{t('common:actions.execute')}</Button>
                      )}
                      {task.status === 'in_progress' && (
                        <Button variant="danger" size="sm" onClick={(e) => { e.stopPropagation(); onStop(task.id); }}>{t('common:actions.stop')}</Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
