import { MOBILE_STATUS_BAR_HEIGHT } from '../../lib/mobileChrome';
import type { ActivityTitleData } from '../../lib/windowDisplay';
import { useActiveWindowRows } from '../../hooks/useActiveWindowRows';
import { useAgentActivity } from '../../hooks/useAgentActivity';
import { buildWindowTaskMap, lookupWindowTask } from '../../lib/windowTask';
import { BrailleSpinner, BlockedDot, FinishedIndicator } from '../ui/WindowActivityIndicator';
import { formatRelativeTime } from '../../utils/time';
import { selectTaskTerminal } from './TaskPanel';
import { useOpenTerminalTarget } from '../../hooks/useTerminalTargetOpener';
import type { TerminalRef } from '../../lib/terminalRef';
import { useEffect, useMemo, useState } from 'react';
import { IconButton } from '../ui/IconButton';
import { Icon } from '../ui/Icon';
import { useTranslation } from 'react-i18next';

export interface MobileActiveWindowsPanelProps {
  titleData: ActivityTitleData;
  onClose: () => void;
  connectPane: (refOrServerName: TerminalRef | string, targetOrProjectId?: string | number, projectId?: number) => void;
  openTask: (taskId: number, title: string, projectId?: number) => void;
  taskWindows: Array<{ serverName: string; tmuxTarget: string; taskId: number }>;
}

export function MobileActiveWindowsPanel({ titleData, onClose, connectPane, openTask, taskWindows }: MobileActiveWindowsPanelProps) {
  const openTerminal = useOpenTerminalTarget(connectPane);
  const { t } = useTranslation(['workspace', 'tasks']);
  const { rows } = useActiveWindowRows(titleData);
  const { markFinishedSeen, markAllFinishedSeen, clearSeenFinished, dismissFinished, retention } = useAgentActivity();
  const [historyOpen, setHistoryOpen] = useState(false);
  useEffect(() => { markAllFinishedSeen(); }, [markAllFinishedSeen]);
  const windowTaskMap = useMemo(() => buildWindowTaskMap(taskWindows), [taskWindows]);

  return (
    <div
      role="dialog"
      aria-label={t('activeWindows.title')}
      className="glass-popover"
      style={{
        position: 'fixed',
        bottom: `calc(${MOBILE_STATUS_BAR_HEIGHT}px + env(safe-area-inset-bottom))`,
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
        maxHeight: `calc(100vh - ${MOBILE_STATUS_BAR_HEIGHT}px - env(safe-area-inset-bottom))`,
        overflowY: 'auto',
        zIndex: 130,
      }}
    >
      <div style={{ fontSize: 'var(--font-2xs)', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-dim)', padding: '6px 10px 4px' }}>
        {t('activeWindows.title')}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
      {rows.some((r) => r.seenAt != null) && <div style={{ display: 'flex', alignItems: 'center', order: 1 }}><button type="button" aria-expanded={historyOpen} onClick={() => setHistoryOpen((v) => !v)} style={{ flex: 1, minHeight: 44, color: 'var(--text)', background: 'none', border: 0, textAlign: 'left' }}>{t('activeWindows.history', { count: rows.filter((r) => r.seenAt != null).length, max: retention.maxCount })}</button><IconButton type="button" aria-label={t('activeWindows.clearHistory')} onClick={clearSeenFinished} style={{ minHeight: 44, minWidth: 44 }}><Icon name="trash" size={14} /></IconButton></div>}
      {rows.length === 0 ? (
        <div style={{ padding: '14px 10px', fontSize: 'var(--font-md)', color: 'var(--text-dim)', textAlign: 'center' }}>
          {t('activeWindows.noActive')}
        </div>
      ) : (
        rows.filter((row) => row.seenAt == null || historyOpen).map((row) => {
          const taskId = row.taskId ?? lookupWindowTask(windowTaskMap, row.serverName, row.target);
          const displayName = row.title;
          const isFinished = row.status === 'finished';
          const isBlocked = !isFinished && row.activityStatus === 'blocked';

          const handleRowOpen = () => {
            if (taskId != null) {
              selectTaskTerminal(taskId, { serverName: row.serverName, target: row.target });
              openTask(taskId, t('tasks:detail.taskRef', { id: taskId }), row.projectId);
            } else {
              openTerminal({ serverName: row.serverName, target: row.target, windowId: row.windowId }, row.projectId);
            }
            if (isFinished) markFinishedSeen(row.serverName, row.target, row.windowId);
            onClose();
          };

          return (
            <div key={row.key} style={{ display: 'flex', alignItems: 'center', order: row.seenAt == null ? 0 : 2 }}>
            <button
              type="button"
              onClick={handleRowOpen}
              className="row-hover"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 10px',
                minHeight: 44,
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
              {isFinished ? <FinishedIndicator seen={row.seenAt != null} /> : isBlocked ? <BlockedDot /> : <BrailleSpinner />}
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
            {row.seenAt != null && <IconButton type="button" aria-label={t('activeWindows.deleteHistory')} onClick={() => dismissFinished(row.serverName, row.target, row.windowId)} style={{ minWidth: 44, minHeight: 44 }}><Icon name="close" size={14} /></IconButton>}
            </div>
          );
        })
      )}
      </div>
    </div>
  );
}
