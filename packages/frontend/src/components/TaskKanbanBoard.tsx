import { StatusBadge, StatusDot } from './StatusBadge';
import { timeAgo } from '../utils/time';
import { useGlobalFocus } from '../hooks/useGlobalFocus';
import TaskRefBadges from './TaskRefBadges';
import { Button } from './ui';
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

interface TaskKanbanBoardProps {
  tasks: Task[];
  projects: Project[];
  units: Unit[];
  showProjectColumn: boolean;
  onTaskClick: (task: Task) => void;
  onExecute: (taskId: number, unitId: number | null) => void;
  onStop: (taskId: number) => void;
}

const TODO_STATUSES = new Set(['open']);
const DONE_STATUSES = new Set(['done', 'failed', 'review', 'archived']);

interface KanbanColumn {
  key: string;
  label: string;
  color: string;
  tasks: Task[];
}

function groupTasks(tasks: Task[]): KanbanColumn[] {
  const todo: Task[] = [];
  const inProgress: Task[] = [];
  const done: Task[] = [];

  for (const t of tasks) {
    if (TODO_STATUSES.has(t.status)) todo.push(t);
    else if (DONE_STATUSES.has(t.status)) done.push(t);
    else inProgress.push(t);
  }

  return [
    { key: 'todo', label: 'todo', color: 'var(--accent)', tasks: todo },
    { key: 'in-progress', label: 'inProgress', color: 'var(--warning)', tasks: inProgress },
    { key: 'done', label: 'done', color: 'var(--success)', tasks: done },
  ];
}

export default function TaskKanbanBoard({
  tasks,
  projects,
  units,
  showProjectColumn,
  onTaskClick,
  onExecute,
  onStop,
}: TaskKanbanBoardProps) {
  const { isFocusedTask } = useGlobalFocus();
  const { t } = useTranslation(['tasks', 'common']);
  const columns = groupTasks(tasks);

  return (
    <div style={{
      display: 'flex',
      gap: 16,
      height: '100%',
      width: '100%',
      maxWidth: '100%',
      overflowX: 'auto',
      padding: '0 0 8px',
    }}>
      {columns.map((col) => (
        <div key={col.key} style={{
          flex: '1 1 0',
          minWidth: 240,
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border)',
          overflow: 'hidden',
        }}>
          <div style={{
            padding: '10px 12px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexShrink: 0,
          }}>
            <span style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: col.color,
              flexShrink: 0,
            }} />
            <span style={{ fontSize: 'var(--font-md)', fontWeight: 600 }}>{t(`kanban.${col.label}`)}</span>
            <span style={{
              fontSize: 'var(--font-xs)',
              color: 'var(--text-dim)',
              background: 'var(--bg-card)',
              padding: '1px 6px',
              borderRadius: 'var(--radius-md)',
            }}>{col.tasks.length}</span>
          </div>

          <div className="mobile-scroll-inset" style={{
            flex: 1,
            overflowY: 'auto',
            padding: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}>
            {col.tasks.length === 0 && (
              <div style={{ color: 'var(--text-dim)', fontSize: 'var(--font-sm)', textAlign: 'center', padding: 16 }}>
                {t('kanban.noTasks')}
              </div>
            )}
            {col.tasks.map((task) => {
              const proj = projects.find((p) => p.id === task.projectId);
              const unit = units.find((u) => u.id === task.unitId);
              const focused = isFocusedTask(task.id);
              return (
                <div
                  key={task.id}
                  className={`kanban-card row-hover${focused ? ' row-selected' : ''}`}
                  onClick={() => onTaskClick(task)}
                  style={{
                    padding: '10px 12px',
                    borderRadius: 'var(--radius-sm)',
                    border: `1px solid ${focused ? 'var(--accent-a15)' : 'var(--border)'}`,
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      <StatusDot status={task.status} />
                      <TaskRefBadges taskId={task.id} sourceRef={task.sourceRef} source={task.source} prUrl={task.prUrl} />
                      {task.windows?.some(w => w.sleeping) && !task.windows?.some(w => !w.sleeping) && (
                        <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)', flexShrink: 0 }}>🌙</span>
                      )}
                    </div>
                    <span style={{
                      fontSize: 'var(--font-md)',
                      fontWeight: 500,
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                      wordBreak: 'break-word',
                    }}>{task.title}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <StatusBadge status={task.status} currentPhase={task.currentPhase} />
                    {task.priority > 0 && (
                      <span style={{
                        fontSize: 'var(--font-2xs)',
                        padding: '1px 6px',
                        borderRadius: 'var(--radius-md)',
                        background: 'var(--danger-a15)',
                        color: 'var(--danger)',
                        fontWeight: 600,
                      }}>P{task.priority}</span>
                    )}
                  </div>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginTop: 8,
                    fontSize: 'var(--font-xs)',
                    color: 'var(--text-dim)',
                    flexWrap: 'wrap',
                  }}>
                    {showProjectColumn && proj && <span>{proj.name}</span>}
                    {unit && <span>{unit.name}</span>}
                    <span style={{ marginLeft: 'auto' }}>{timeAgo(task.createdAt)}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    {task.status === 'open' && (
                      <Button
                        size="sm" variant="primary"
                        onClick={(e) => { e.stopPropagation(); onExecute(task.id, task.unitId); }}
                        style={{ fontSize: 'var(--font-xs)', padding: '2px 8px' }}
                      >{t('common:actions.execute')}</Button>
                    )}
                    {task.status === 'in_progress' && (
                      <Button
                        size="sm" variant="danger"
                        onClick={(e) => { e.stopPropagation(); onStop(task.id); }}
                        style={{ fontSize: 'var(--font-xs)', padding: '2px 8px' }}
                      >{t('common:actions.stop')}</Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
