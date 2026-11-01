import type { ActivityTitleData } from '../../lib/windowDisplay';
import { useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useActiveWindowRows } from '../../hooks/useActiveWindowRows';
import type { ActiveWindowRow } from '../../hooks/useActiveWindowRows';
import { useClickOutside } from '../../hooks/useClickOutside';
import { BrailleSpinner, BlockedDot, FinishedIndicator } from '../ui/WindowActivityIndicator';
import { formatRelativeTime } from '../../utils/time';
import { openActivityTarget } from '../../lib/activityOpen';
import { useOpenTerminalTarget } from '../../hooks/useTerminalTargetOpener';
import type { ConnectPaneFn } from '../../lib/terminalRef';
import { groupRunningRows } from '../../lib/activityPillLogic';
import { MOBILE_STATUS_BAR_HEIGHT } from '../../lib/mobileChrome';
import { IconButton } from '../ui/IconButton';
import { Icon } from '../ui/Icon';
import { useAgentActivity } from '../../hooks/useAgentActivity';
import type { Task } from '../../pages/workspace/types';
import { HealthDot } from '../statusbar/HealthDot';
import { ResourceMeter } from '../statusbar/ResourceMeter';
import { healthReasonText } from '../statusbar/ResourceDropdown';
import { getHealthLevel, getWorstHealth, useServerResourcesContext } from '../../hooks/useServerResources';
import { ServerHealthSheet } from './ServerHealthSheet';

// SP常設ステータスバー（Issue #338 T13）。旧 FloatingActivityPill（右下フローティングピル）を
// 廃止し、画面最下段の常駐バーへ置き換えたもの。データ・集計ロジック（グループ化・既読ID管理・
// ヘルス判定）は共通ロジックを利用する（groupRunningRows は lib/activityPillLogic.ts、
// getHealthLevel/getWorstHealth は hooks/useServerResources.tsx を
// 引き続き共有する）。配置は Layout の mobile-shell-slot と対になる mobile-status-slot への
// createPortal（Workspace.tsx）— グローバルページ表示中も常駐する。



interface MobileStatusBarProps {
  titleData: ActivityTitleData;
  allTasks: Task[];
  openTask: (taskId: number, title: string, projectId?: number) => void;
  connectPane: ConnectPaneFn;
}

interface WorkingGroup {
  key: string;
  taskId?: number;
  projectId?: number;
  title: string;
  meta?: string;
  isBlocked: boolean;
  row: ActiveWindowRow;
}

const rowButtonStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  width: '100%',
  minWidth: 0,
  border: 'none',
  background: 'none',
  color: 'var(--text)',
  textAlign: 'left',
  cursor: 'pointer',
  padding: '6px 8px',
  minHeight: 44,
  borderRadius: 'var(--radius-sm)',
  font: 'inherit',
  fontSize: 'var(--font-sm)',
};

const sectionHeaderStyle: CSSProperties = {
  fontSize: 'var(--font-2xs)',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: 'var(--text-dim)',
  padding: '4px 8px',
};

const rowTitleStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export function MobileStatusBar({ titleData, allTasks, openTask, connectPane }: MobileStatusBarProps) {
  const openTerminal = useOpenTerminalTarget(connectPane);
  const { t } = useTranslation(['workspace', 'common']);
  const { rows } = useActiveWindowRows(titleData);
  const [open, setOpen] = useState(false);
  const { markAllFinishedSeen, dismissFinished, clearSeenFinished, retention } = useAgentActivity();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);
  const containerRef = useClickOutside<HTMLDivElement>(() => setOpen(false));

  // サーバーヘルス。複数サーバーは最悪値を代表として使う。
  const servers = useServerResourcesContext();
  const worstHealth = getWorstHealth(servers.map((s) => getHealthLevel(s.measurement)));
  const worstServer = servers.find((s) => getHealthLevel(s.measurement) === worstHealth) ?? null;
  const worstMeasurement = worstServer?.measurement ?? null;
  const worstMemUsedPercent = worstMeasurement ? 100 - worstMeasurement.memAvailablePercent : null;
  const memTextColor = worstHealth === 'critical' ? 'var(--danger)' : worstHealth === 'warning' ? 'var(--warning)' : 'var(--text-dim)';

  const taskById = useMemo(() => new Map(allTasks.map((tk) => [tk.id, tk])), [allTasks]);

  const workingGroups = useMemo<WorkingGroup[]>(() => {
    return groupRunningRows(rows).map(({ groupKey, isBlocked, representativeRow: row }) => {
      const task = row.taskId != null ? taskById.get(row.taskId) : undefined;
      return {
        key: groupKey,
        taskId: row.taskId,
        projectId: row.projectId,
        title: row.title,
        meta: task ? t(`common:status.${task.status}`) : undefined,
        isBlocked,
        row,
      };
    });
  }, [rows, taskById, t]);

  const finishedRows = useMemo(() => rows.filter((r) => r.status === 'finished'), [rows]);

  const unreadFinishedCount = useMemo(
    () => finishedRows.filter((r) => r.seenAt == null).length,
    [finishedRows],
  );

  const workingCount = workingGroups.length;

  const handleToggle = () => {
    if (!open) markAllFinishedSeen();
    setOpen(!open);
  };

  const handleWorkingRowOpen = (group: WorkingGroup) => {
    openActivityTarget(
      { taskId: group.taskId, serverName: group.row.serverName, windowId: group.row.windowId, target: group.row.target, projectId: group.projectId },
      group.title,
      openTask,
      openTerminal,
    );
    setOpen(false);
  };

  const handleFinishedRowOpen = (row: ActiveWindowRow) => {
    openActivityTarget(
      { taskId: row.taskId, serverName: row.serverName, windowId: row.windowId, target: row.target, projectId: row.projectId },
      row.title,
      openTask,
      openTerminal,
    );
    setOpen(false);
  };

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      {open && (
        <div
          role="dialog"
          aria-label={t('workspace:activityPill.ariaLabel')}
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: `calc(${MOBILE_STATUS_BAR_HEIGHT}px + env(safe-area-inset-bottom))`,
            zIndex: 100,
            maxHeight: '60vh',
            overflowY: 'auto',
            background: 'var(--bg-elevated)',
            borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0',
            boxShadow: 'var(--shadow-3)',
            padding: 'var(--space-2)',
          }}
        >
          {workingCount > 0 && (
            <section>
              <div style={sectionHeaderStyle}>{t('workspace:activityPill.workingSection', { count: workingCount })}</div>
              {workingGroups.map((group) => (
                <button
                  key={group.key}
                  type="button"
                  className={`row-hover${!group.isBlocked ? ' aw-row-working' : ''}`}
                  onClick={() => handleWorkingRowOpen(group)}
                  style={rowButtonStyle}
                >
                  {group.isBlocked ? <BlockedDot /> : <BrailleSpinner />}
                  <span style={rowTitleStyle}>{group.title}</span>
                  {group.meta && (
                    <span style={{ flexShrink: 0, fontSize: 'var(--font-2xs)', color: 'var(--text-dim)' }}>
                      {group.meta}
                    </span>
                  )}
                </button>
              ))}
            </section>
          )}
          {finishedRows.length > 0 && (
            <section>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <button type="button" aria-expanded={historyOpen} onClick={() => setHistoryOpen((v) => !v)} style={{ ...rowButtonStyle, flex: 1 }}>{t('workspace:activeWindows.history', { count: finishedRows.length, max: retention.maxCount })}</button>
                <IconButton type="button" title={t('workspace:activeWindows.clearHistory')} aria-label={t('workspace:activeWindows.clearHistory')} onClick={clearSeenFinished} style={{ minWidth: 44, minHeight: 44 }}><Icon name="trash" size={14} /></IconButton>
              </div>
              {historyOpen && finishedRows.map((row) => (
                <div key={row.key} style={{ display: 'flex', alignItems: 'center' }}>
                  <button type="button" className="row-hover" onClick={() => handleFinishedRowOpen(row)} style={rowButtonStyle}>
                    <FinishedIndicator seen={row.seenAt != null} />
                    <span style={{ ...rowTitleStyle, color: 'var(--text-dim)' }}>{row.title}</span>
                    {row.finishedAt != null && <span style={{ color: 'var(--text-dim)', fontSize: 'var(--font-2xs)' }}>{formatRelativeTime(row.finishedAt)}</span>}
                  </button>
                  <IconButton type="button" aria-label={t('workspace:activeWindows.deleteHistory')} onClick={() => dismissFinished(row.serverName, row.target, row.windowId)} style={{ minWidth: 44, minHeight: 44 }}><Icon name="close" size={14} /></IconButton>
                </div>
              ))}
            </section>
          )}
          {workingCount === 0 && finishedRows.length === 0 && (
            <div style={{ padding: '12px 8px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--font-sm)' }}>
              {t('workspace:activityPill.empty')}
            </div>
          )}

          {/* サーバーヘルス節。アイドル時（稼働0・未読完了0）でも表示する。 */}
          <section style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between', gap: 4, padding: '4px 8px 6px' }}>
              <span style={{ ...sectionHeaderStyle, padding: 0, whiteSpace: 'nowrap' }}>{t('workspace:mobile.serverHealth')}</span>
              <span style={{ fontSize: 'var(--font-2xs)', fontWeight: 600, color: memTextColor, flexShrink: 0, whiteSpace: 'nowrap' }}>
                {healthReasonText(worstHealth, worstMemUsedPercent, worstServer?.unavailable ?? null, t)}
              </span>
            </div>
            {worstMeasurement && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '0 8px 8px' }}>
                <MiniHealthRow label="MEM" value={worstMemUsedPercent ?? 0} warning={(worstMemUsedPercent ?? 0) >= 60} />
                {worstMeasurement.loadPerCore !== null && (
                  <MiniHealthRow
                    label="CPU"
                    value={Math.min(100, worstMeasurement.loadPerCore * 100)}
                    warning={worstMeasurement.loadPerCore > 1.5}
                  />
                )}
              </div>
            )}
            <button
              type="button"
              className="row-hover"
              onClick={() => { setOpen(false); setHealthOpen(true); }}
              style={{ ...rowButtonStyle, justifyContent: 'space-between', color: 'var(--text-dim)' }}
            >
              <span>{t('workspace:activityPill.viewHealthDetails')}</span>
            </button>
          </section>
        </div>
      )}

      <div
        style={{
          background: 'var(--bg-card)',
          boxShadow: 'inset 0 1px 0 var(--edge-hi)',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
      >
        <button
          type="button"
          onClick={handleToggle}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={t('workspace:activityPill.ariaLabel')}
          className={workingCount > 0 ? 'aw-pill-sweep-host' : undefined}
          style={{
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            width: '100%',
            height: MOBILE_STATUS_BAR_HEIGHT,
            padding: '0 var(--space-3)',
            border: 'none',
            background: 'transparent',
            color: 'var(--text)',
            fontFamily: 'var(--mono)',
            fontSize: 'var(--font-2xs)',
            cursor: 'pointer',
          }}
        >
          {workingCount > 0 && <span className="aw-sweep-overlay" aria-hidden="true" />}

          <span style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, overflow: 'hidden' }}>
            {workingCount > 0 ? <BrailleSpinner /> : <span aria-hidden="true" style={{ color: 'var(--text-dim)' }}>⠿</span>}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t('workspace:activityPill.statusBarWorking', { count: workingCount })}
            </span>
            {unreadFinishedCount > 0 && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                <span aria-hidden="true" style={{ color: 'var(--text-dim)' }}>&middot;</span>
                <span aria-hidden="true" style={{ color: 'var(--success)' }}>&#10003;</span>
                <span style={{ color: 'var(--success)' }}>{unreadFinishedCount}</span>
              </span>
            )}
          </span>

          <span style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <HealthDot level={worstHealth} size={7} />
            <span style={{ color: memTextColor }}>
              MEM {worstMemUsedPercent !== null ? `${Math.round(worstMemUsedPercent)}%` : '--%'}
            </span>
          </span>
        </button>
      </div>

      <ServerHealthSheet open={healthOpen} onClose={() => setHealthOpen(false)} />
    </div>
  );
}

function MiniHealthRow({ label, value, warning }: { label: string; value: number; warning: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--mono)', fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>
      <span style={{ minWidth: 30, color: 'var(--text)', fontWeight: 600 }}>{label}</span>
      <ResourceMeter value={value} warning={warning} width={64} height={4} />
      <span style={{ marginLeft: 'auto' }}>{Math.round(Math.max(0, Math.min(100, value)))}%</span>
    </div>
  );
}
