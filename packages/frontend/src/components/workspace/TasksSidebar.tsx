import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { StatusDot } from '../StatusBadge';
import type { Task } from '../../pages/workspace/types';

const MAX_RECENT_TASKS = 5;

interface TasksSidebarProps {
  /** 現在のプロジェクトに紐づくタスク一覧（呼び出し元で projectId フィルタ済み）。 */
  tasks: Task[];
  onOpenTask: (taskId: number, title: string) => void;
  onOpenAllTasks: () => void;
}

function taskTimestamp(task: Task): number {
  const raw = task.updatedAt || task.createdAt;
  const parsed = new Date(raw).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

export default function TasksSidebar({ tasks, onOpenTask, onOpenAllTasks }: TasksSidebarProps) {
  const { t } = useTranslation('tasks');
  const recentTasks = tasks
    .filter((task) => task.status !== 'archived')
    .slice()
    .sort((a, b) => taskTimestamp(b) - taskTimestamp(a))
    .slice(0, MAX_RECENT_TASKS);

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
            {recentTasks.length}
          </span>
        </span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px 4px' }}>
        {recentTasks.length === 0 ? (
          <div style={{ padding: '10px 4px', fontSize: 'var(--font-sm)', color: 'var(--text-dim)' }}>
            {t('sidebar.noRecentTasks')}
          </div>
        ) : (
          recentTasks.map((task) => (
            <button
              key={task.id}
              type="button"
              onClick={() => onOpenTask(task.id, task.title)}
              title={task.title}
              className="row-hover"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                padding: '6px 8px',
                borderRadius: 'var(--radius-md)',
                background: 'none',
                border: 'none',
                color: 'var(--text)',
                textAlign: 'left',
                cursor: 'pointer',
                fontSize: 'var(--font-md)',
              }}
            >
              <StatusDot status={task.status} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {task.title}
              </span>
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
            </button>
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
