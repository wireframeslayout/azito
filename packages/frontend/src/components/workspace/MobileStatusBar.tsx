import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { ActiveWindowRow } from '../../hooks/useActiveWindowRows';
import { useClickOutside } from '../../hooks/useClickOutside';
import { BrailleSpinner, BlockedDot, FinishedIndicator } from '../ui/WindowActivityIndicator';
import { formatRelativeTime } from '../../utils/time';
import { openActivityTarget } from '../../lib/activityOpen';
import { openLookoutItem } from '../../lib/lookoutOpen';
import { useOpenTerminalTarget } from '../../hooks/useTerminalTargetOpener';
import type { ConnectPaneFn } from '../../lib/terminalRef';
import { useLookoutSummaries } from '../../hooks/useLookoutSummaries';
import { LookoutCounts } from '../lookout/LookoutCounts';
import { LookoutSection } from '../lookout/LookoutSection';
import { LookoutSummaryText } from '../lookout/LookoutSummaryText';
import { useLookout } from '../../hooks/useLookout';
import type { LookoutItem } from '../../lib/lookoutSummary';
import { MOBILE_STATUS_BAR_HEIGHT } from '../../lib/mobileChrome';
import { IconButton } from '../ui/IconButton';
import { Icon } from '../ui/Icon';
import { Button, Notice } from '../ui';
import { useAgentActivity } from '../../hooks/useAgentActivity';
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
  openTask: (taskId: number, title: string, projectId?: number) => void;
  connectPane: ConnectPaneFn;
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

export function MobileStatusBar({ openTask, connectPane }: MobileStatusBarProps) {
  const openTerminal = useOpenTerminalTarget(connectPane);
  const { t } = useTranslation(['workspace', 'common', 'lookout']);
  const { sections, rows, historyCount, open, openDrawer, closeDrawer } = useLookout();
  const { markFinishedSeen, dismissFinished, clearSeenFinished, retention, snapshotStatus, retrySnapshot } = useAgentActivity();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [healthOpen, setHealthOpen] = useState(false);
  const openedUnread = useRef<ActiveWindowRow[]>([]);
  const closePanel = () => {
    for (const captured of openedUnread.current) {
      const current = rows.find((row) => row.key === captured.key && row.finishedAt === captured.finishedAt && row.seenAt == null);
      if (current) markFinishedSeen(current.serverName, current.target, current.windowId);
    }
    openedUnread.current = [];
    closeDrawer();
  };
  const containerRef = useClickOutside<HTMLDivElement>(() => { if (open) closePanel(); });

  // サーバーヘルス。複数サーバーは最悪値を代表として使う。
  const servers = useServerResourcesContext();
  const worstHealth = getWorstHealth(servers.map((s) => getHealthLevel(s.measurement)));
  const worstServer = servers.find((s) => getHealthLevel(s.measurement) === worstHealth) ?? null;
  const worstMeasurement = worstServer?.measurement ?? null;
  const worstMemUsedPercent = worstMeasurement ? 100 - worstMeasurement.memAvailablePercent : null;
  const memTextColor = worstHealth === 'critical' ? 'var(--danger)' : worstHealth === 'warning' ? 'var(--warning)' : 'var(--text-dim)';

  const workingGroups = [...sections.attention, ...sections.active];
  const visibleFinished = rows.filter(row => row.status === 'finished' && (row.seenAt == null || historyOpen)).map((row): LookoutItem => ({ key: row.key, title: row.title, status: 'finished', primaryRow: row, projectId: row.projectId, activeWindows: 0, totalWindows: 1, windowNames: [row.title], hasBlocked: false }));
  const summaries = useLookoutSummaries([...workingGroups, ...visibleFinished], open);

  const finishedRows = useMemo(() => rows.filter((r) => r.status === 'finished'), [rows]);

  const unreadRows = finishedRows.filter((r) => r.seenAt == null);
  const historyRows = finishedRows.filter((r) => r.seenAt != null);
  const unreadFinishedCount = unreadRows.length;

  const workingCount = workingGroups.filter((group) => group.activeWindows > 0).length;

  useEffect(() => {
    if (open) openedUnread.current = unreadRows;
  }, [open]);

  const handleToggle = () => {
    if (open) {
      closePanel();
    } else {
      openDrawer();
    }
  };

  const handleWorkingRowOpen = (group: LookoutItem) => {
    openLookoutItem(group, openTask, openTerminal);
    closePanel();
  };

  const handleFinishedRowOpen = (row: ActiveWindowRow) => {
    openActivityTarget(
      { taskId: row.taskId, serverName: row.serverName, windowId: row.windowId, target: row.target, projectId: row.projectId },
      row.title,
      openTask,
      openTerminal,
    );
    if (!openedUnread.current.some((captured) => captured.key === row.key && captured.finishedAt === row.finishedAt)) {
      markFinishedSeen(row.serverName, row.target, row.windowId);
    }
    closePanel();
  };

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      {open && (
        <div className="floating-surface"
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
            background: 'var(--bg-solid)',
            borderRadius: 'var(--radius-lg) var(--radius-lg) 0 0',
            boxShadow: 'var(--shadow-3)',
            padding: 'var(--space-2)',
          }}
        >
          <LookoutCounts counts={sections.counts} activityKnown={snapshotStatus === 'ready'} />
          {snapshotStatus === 'error' && <Notice tone="warning" role="alert" action={<Button size="sm" onClick={retrySnapshot}>{t('lookout:retry')}</Button>}>{t('lookout:loadError')}</Notice>}
          {snapshotStatus === 'loading' && <p role="status" style={{ color: 'var(--text-dim)' }}>{t('lookout:loading')}</p>}
          <LookoutSection name="attention" items={sections.attention} onOpen={handleWorkingRowOpen} summaries={summaries} empty={snapshotStatus === 'ready' ? <p>{t('lookout:emptyAttention')}</p> : <></>} />
          {sections.active.length > 0 && (
            <section>
              <div style={sectionHeaderStyle}>{t('workspace:activityPill.workingSection', { count: sections.active.length })}</div>
              {sections.active.map((group) => (
                <button
                  key={group.key}
                  type="button"
                  className={`row-hover${group.status === 'working' ? ' aw-row-working' : ''}`}
                  onClick={() => handleWorkingRowOpen(group)}
                  style={rowButtonStyle}
                >
                  {group.status !== 'working' ? <BlockedDot /> : <BrailleSpinner />}
                  <span style={{ ...rowTitleStyle, whiteSpace: 'normal' }}><span>{group.title}</span><LookoutSummaryText summary={summaries.get(group.key)} /></span>
                  {group.status !== 'working' && (
                    <span style={{ flexShrink: 0, fontSize: 'var(--font-2xs)', color: 'var(--text-dim)' }}>
                      {t(`lookout:status.${group.status}`)}
                    </span>
                  )}
                </button>
              ))}
            </section>
          )}
          {unreadRows.length > 0 && (
            <section>
              <div style={sectionHeaderStyle}>{t('workspace:activityPill.finishedSection', { count: unreadRows.length })}</div>
              {unreadRows.map((row) => <button key={row.key} type="button" className="row-hover" onClick={() => handleFinishedRowOpen(row)} style={rowButtonStyle}>
                <FinishedIndicator /><span style={{ ...rowTitleStyle, whiteSpace: 'normal' }}>{row.title}<LookoutSummaryText summary={summaries.get(row.key)} /></span>
                {row.finishedAt != null && <span style={{ color: 'var(--success)', fontSize: 'var(--font-2xs)' }}>{t('workspace:activeWindows.done')} · {formatRelativeTime(row.finishedAt)}</span>}
              </button>)}
            </section>
          )}
          {historyRows.length > 0 && (
            <section>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <button type="button" aria-expanded={historyOpen} onClick={() => setHistoryOpen((v) => !v)} style={{ ...rowButtonStyle, flex: 1 }}>{t('workspace:activeWindows.history', { count: historyCount, max: retention.maxCount })}</button>
                <IconButton type="button" title={t('workspace:activeWindows.clearHistory')} aria-label={t('workspace:activeWindows.clearHistory')} onClick={clearSeenFinished} style={{ minWidth: 44, minHeight: 44 }}><Icon name="trash" size={14} /></IconButton>
              </div>
              {historyOpen && historyRows.map((row) => (
                <div key={row.key} style={{ display: 'flex', alignItems: 'center' }}>
                  <button type="button" className="row-hover" onClick={() => handleFinishedRowOpen(row)} style={rowButtonStyle}>
                    <FinishedIndicator seen={row.seenAt != null} />
                    <span style={{ ...rowTitleStyle, color: 'var(--text-dim)', whiteSpace: 'normal' }}>{row.title}<LookoutSummaryText summary={summaries.get(row.key)} /></span>
                    {row.finishedAt != null && <span style={{ color: 'var(--text-dim)', fontSize: 'var(--font-2xs)' }}>{t('workspace:activeWindows.done')} · {formatRelativeTime(row.finishedAt)}</span>}
                  </button>
                  <IconButton type="button" aria-label={t('workspace:activeWindows.deleteHistory')} onClick={() => dismissFinished(row.serverName, row.target, row.windowId)} style={{ minWidth: 44, minHeight: 44 }}><Icon name="close" size={14} /></IconButton>
                </div>
              ))}
            </section>
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
              onClick={() => { closePanel(); setHealthOpen(true); }}
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
            fontSize: 'var(--font-2xs)',
            cursor: 'pointer',
          }}
        >
          {workingCount > 0 && <span className="aw-sweep-overlay" aria-hidden="true" />}

          <span style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0, overflow: 'hidden' }}>
            {workingCount > 0 ? <BrailleSpinner /> : <span aria-hidden="true" style={{ color: 'var(--text-dim)' }}>⠿</span>}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {snapshotStatus === 'ready' ? t('workspace:activityPill.statusBarWorking', { count: workingCount }) : t('workspace:activityPill.statusBarUnknown')}
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
            <span style={{ color: memTextColor, fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}>
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
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--font-mono)', fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>
      <span style={{ minWidth: 30, color: 'var(--text)', fontWeight: 600 }}>{label}</span>
      <ResourceMeter value={value} warning={warning} width={64} height={4} />
      <span style={{ marginLeft: 'auto' }}>{Math.round(Math.max(0, Math.min(100, value)))}%</span>
    </div>
  );
}
