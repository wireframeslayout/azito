import { useActiveWindowRows } from '../../hooks/useActiveWindowRows';
import { useAgentActivity } from '../../hooks/useAgentActivity';
import { buildWindowTaskMap, lookupWindowTask } from '../../lib/windowTask';
import { BrailleSpinner, BlockedDot, FinishedIndicator } from '../ui/WindowActivityIndicator';
import { formatRelativeTime } from '../../utils/time';
import { selectTaskTerminal } from './TaskPanel';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

export interface MobileActiveWindowsPanelProps {
  onClose: () => void;
  connectPane: (serverName: string, target: string, projectId?: number) => void;
  openTask: (taskId: number, title: string, projectId?: number) => void;
  taskWindows: Array<{ serverName: string; tmuxTarget: string; taskId: number }>;
}

export function MobileActiveWindowsPanel({ onClose, connectPane, openTask, taskWindows }: MobileActiveWindowsPanelProps) {
  const { t } = useTranslation(['workspace', 'tasks']);
  const { rows } = useActiveWindowRows();
  const { dismissFinished } = useAgentActivity();
  const windowTaskMap = useMemo(() => buildWindowTaskMap(taskWindows), [taskWindows]);

  return (
    <div
      role="dialog"
      aria-label={t('activeWindows.title')}
      className="glass-popover"
      style={{
        position: 'fixed',
        bottom: 'calc(76px + env(safe-area-inset-bottom))',
        right: 14,
        borderRadius: 'var(--radius-lg)',
        background: 'rgba(22, 27, 34, 0.86)',
        border: '1px solid rgba(139, 148, 158, 0.25)',
        backdropFilter: 'blur(16px) saturate(1.3)',
        WebkitBackdropFilter: 'blur(16px) saturate(1.3)',
        boxShadow: '0 12px 36px rgba(0, 0, 0, 0.5)',
        padding: 6,
        width: 260,
        maxWidth: 'calc(100vw - 28px)',
        maxHeight: 'calc(100vh - 140px)',
        overflowY: 'auto',
        zIndex: 130,
      }}
    >
      <div style={{ fontSize: 'var(--font-2xs)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', padding: '6px 10px 4px' }}>
        {t('activeWindows.title')}
      </div>

      {rows.length === 0 ? (
        <div style={{ padding: '14px 10px', fontSize: 'var(--font-md)', color: 'var(--text-dim)', textAlign: 'center' }}>
          {t('activeWindows.noActive')}
        </div>
      ) : (
        rows.map((row) => {
          const taskId = row.taskId ?? lookupWindowTask(windowTaskMap, row.serverName, row.target);
          const displayName = row.paneName || row.label || row.target;
          const windowLabel = row.label || row.target;
          const isFinished = row.status === 'finished';
          const isBlocked = !isFinished && row.activityStatus === 'blocked';

          const handleRowOpen = () => {
            if (taskId != null) {
              selectTaskTerminal(taskId, { serverName: row.serverName, target: row.target });
              openTask(taskId, t('tasks:detail.taskRef', { id: taskId }), row.projectId);
            } else {
              connectPane(row.serverName, row.target, row.projectId);
            }
            if (isFinished) dismissFinished(row.serverName, row.target);
            onClose();
          };

          return (
            <button
              key={row.key}
              type="button"
              onClick={handleRowOpen}
              className="row-hover"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 10px',
                borderRadius: 'var(--radius-md)',
                background: isBlocked ? 'rgba(210, 153, 34, 0.06)' : 'transparent',
                border: 'none',
                color: 'var(--text)',
                textAlign: 'left',
                cursor: 'pointer',
                fontSize: 'var(--font-md)',
                width: '100%',
              }}
            >
              {isFinished ? <FinishedIndicator /> : isBlocked ? <BlockedDot /> : <BrailleSpinner />}
              <div style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {displayName}
                  </span>
                  {isFinished && row.finishedAt != null && (
                    <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--success)', flexShrink: 0, whiteSpace: 'nowrap' }}>
                      {t('activeWindows.done')} · {formatRelativeTime(row.finishedAt)}
                    </span>
                  )}
                </div>
                {windowLabel !== displayName && (
                  <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
                    {windowLabel}
                  </div>
                )}
              </div>
              {isBlocked && (
                <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--warning)', background: 'rgba(210, 153, 34, 0.15)', borderRadius: 'var(--radius-sm)', padding: '1px 5px', flexShrink: 0 }}>
                  {t('activeWindows.planReview')}
                </span>
              )}
              {taskId != null && (
                <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--text-dim)', background: 'var(--bg)', borderRadius: 'var(--radius-sm)', padding: '1px 5px', flexShrink: 0 }}>
                  #{taskId}
                </span>
              )}
            </button>
          );
        })
      )}
    </div>
  );
}
