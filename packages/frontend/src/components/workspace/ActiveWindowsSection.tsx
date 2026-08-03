import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';
import { useAgentActivity } from '../../hooks/useAgentActivity';
import { useActiveWindowRows } from '../../hooks/useActiveWindowRows';
import { BrailleSpinner, BlockedDot, FinishedIndicator } from '../ui/WindowActivityIndicator';
import { formatRelativeTime } from '../../utils/time';
import { buildWindowTaskMap, lookupWindowTask } from '../../lib/windowTask';
import { selectTaskTerminal } from './TaskPanel';

const COLLAPSE_STORAGE_KEY = 'active-windows-collapsed';
const HEADER_HEIGHT = 36;

function loadUserCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveUserCollapsed(value: boolean): void {
  try {
    localStorage.setItem(COLLAPSE_STORAGE_KEY, value ? '1' : '0');
  } catch {
    /* best-effort */
  }
}

export interface ActiveWindowsSectionProps {
  connectPane: (serverName: string, target: string, projectId?: number) => void;
  openTask: (taskId: number, title: string, projectId?: number) => void;
  taskWindows: Array<{ serverName: string; tmuxTarget: string; taskId: number }>;
}

export default function ActiveWindowsSection({ connectPane, openTask, taskWindows }: ActiveWindowsSectionProps) {
  const { t } = useTranslation(['workspace', 'tasks']);
  const { dismissFinished } = useAgentActivity();
  const { rows, totalCount: count } = useActiveWindowRows();
  const windowTaskMap = useMemo(() => buildWindowTaskMap(taskWindows), [taskWindows]);

  const [userCollapsed, setUserCollapsed] = useState<boolean>(loadUserCollapsed);
  const prevCountRef = useRef(count);

  useEffect(() => {
    if (prevCountRef.current === 0 && count > 0 && userCollapsed) {
      setUserCollapsed(false);
      saveUserCollapsed(false);
    }
    prevCountRef.current = count;
  }, [count, userCollapsed]);

  const collapsed = count === 0 ? true : userCollapsed;

  const handleToggle = () => {
    if (count === 0) return;
    setUserCollapsed((prev) => {
      const next = !prev;
      saveUserCollapsed(next);
      return next;
    });
  };

  return (
    <div
      style={{
        height: collapsed ? HEADER_HEIGHT : '50%',
        flexShrink: 0,
        boxShadow: '0 -1px 0 var(--hairline)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={!collapsed}
        disabled={count === 0}
        title={count === 0 ? undefined : (collapsed ? t('activeWindows.expand') : t('activeWindows.minimize'))}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '0 12px',
          background: 'none',
          border: 'none',
          cursor: count === 0 ? 'default' : 'pointer',
          color: 'var(--text-dim)',
          fontSize: 'var(--font-xs)',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: 0.5,
          height: HEADER_HEIGHT,
          flexShrink: 0,
          width: '100%',
          textAlign: 'left',
        }}
      >
        <span aria-hidden="true" style={{ opacity: count === 0 ? 0.3 : 1, display: 'inline-flex' }}>
          <Icon name="chevron-right" size={14} rotate={collapsed ? 0 : 90} />
        </span>
        {count > 0 && (
          <span
            aria-hidden="true"
            style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)', flexShrink: 0 }}
          />
        )}
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {t('activeWindows.titleWithCount', { count })}
        </span>
      </button>

      {!collapsed && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 4px 8px' }}>
          {rows.map((row) => {
            const taskId = row.taskId ?? lookupWindowTask(windowTaskMap, row.serverName, row.target);
            const displayName = row.paneName || row.label || row.target;
            const windowLabel = row.label || row.target;
            const isFinished = row.status === 'finished';
            const isBlocked = !isFinished && row.activityStatus === 'blocked';
            const dismissIfFinished = () => {
              if (isFinished) dismissFinished(row.serverName, row.target);
            };
            const handleRowOpen = () => {
              if (taskId != null) {
                selectTaskTerminal(taskId, { serverName: row.serverName, target: row.target });
                openTask(taskId, t('tasks:detail.taskRef', { id: taskId }), row.projectId);
              } else {
                connectPane(row.serverName, row.target, row.projectId);
              }
              dismissIfFinished();
            };
            return (
              <div
                key={row.key}
                className={`row-hover${!isFinished && !isBlocked ? ' aw-row-working' : ''}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 8px',
                  borderRadius: 'var(--radius-sm)',
                  background: isBlocked ? 'rgba(210, 153, 34, 0.06)' : undefined,
                }}
              >
                {isFinished ? <FinishedIndicator /> : isBlocked ? <BlockedDot /> : <BrailleSpinner />}
                <button
                  type="button"
                  onClick={handleRowOpen}
                  title={isFinished ? `${displayName} (${t('activeWindows.done')})` : isBlocked ? `${displayName} (${t('activeWindows.planReview')})` : displayName}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    background: 'none',
                    border: 'none',
                    color: 'var(--text)',
                    textAlign: 'left',
                    cursor: 'pointer',
                    fontSize: 'var(--font-md)',
                    padding: 0,
                    overflow: 'hidden',
                  }}
                >
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
                      {isBlocked && (
                        <span style={{ fontSize: 'var(--font-2xs)', color: 'var(--warning)', flexShrink: 0, whiteSpace: 'nowrap' }}>
                          {t('activeWindows.planReview')}
                        </span>
                      )}
                    </div>
                    {windowLabel !== displayName && (
                      <div style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
                        {windowLabel}
                      </div>
                    )}
                  </div>
                </button>
                {isBlocked && (
                  <span
                    style={{
                      fontSize: 'var(--font-2xs)', color: 'var(--warning)', background: 'rgba(210, 153, 34, 0.15)',
                      borderRadius: 'var(--radius-sm)', padding: '1px 5px', flexShrink: 0,
                    }}
                  >
                    {t('activeWindows.planReview')}
                  </span>
                )}
                {taskId != null && (
                  <span
                    style={{
                      fontSize: 'var(--font-2xs)', color: 'var(--text-dim)', background: 'var(--bg)',
                      borderRadius: 'var(--radius-sm)', padding: '1px 5px', flexShrink: 0,
                    }}
                  >
                    #{taskId}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
