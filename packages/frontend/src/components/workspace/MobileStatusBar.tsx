import { useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useActiveWindowRows } from '../../hooks/useActiveWindowRows';
import type { ActiveWindowRow } from '../../hooks/useActiveWindowRows';
import { useClickOutside } from '../../hooks/useClickOutside';
import { BrailleSpinner, BlockedDot, FinishedIndicator } from '../ui/WindowActivityIndicator';
import { formatRelativeTime } from '../../utils/time';
import { openActivityTarget } from '../../lib/activityOpen';
import { groupRunningRows, readKeyFor, pruneStaleReadKeys } from '../../lib/activityPillLogic';
import { FINISHED_TTL_MS } from '../../hooks/useAgentActivity';
import type { Task } from '../../pages/workspace/types';
import { HealthDot } from '../statusbar/HealthDot';
import { ResourceMeter } from '../statusbar/ResourceMeter';
import { healthReasonText } from '../statusbar/ResourceDropdown';
import { getHealthLevel, getWorstHealth, useServerResourcesContext } from '../../hooks/useServerResources';
import { ServerHealthSheet } from './ServerHealthSheet';

// SP常設ステータスバー（Issue #338 T13）。旧 FloatingActivityPill（右下フローティングピル）を
// 廃止し、画面最下段の常駐バーへ置き換えたもの。データ・集計ロジック（グループ化・既読ID管理・
// ヘルス判定）はそのまま移設している（コピー禁止 — groupRunningRows/readKeyFor/pruneStaleReadKeys
// は lib/activityPillLogic.ts、getHealthLevel/getWorstHealth は hooks/useServerResources.tsx を
// 引き続き共有する）。配置は Layout の mobile-shell-slot と対になる mobile-status-slot への
// createPortal（Workspace.tsx）— グローバルページ表示中も常駐する。

const BAR_HEIGHT = 26;

interface MobileStatusBarProps {
  allTasks: Task[];
  openTask: (taskId: number, title: string, projectId?: number) => void;
  connectPane: (serverName: string, target: string, projectId?: number) => void;
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

export function MobileStatusBar({ allTasks, openTask, connectPane }: MobileStatusBarProps) {
  const { t } = useTranslation(['workspace', 'common']);
  const { rows } = useActiveWindowRows();
  const [open, setOpen] = useState(false);
  // セッション内既読管理（spec: localStorage不要）。ドロップアップを開いた時点の完了行キーを
  // 既読にし、以後バッジの未読数から外す。
  const [readKeys, setReadKeys] = useState<Set<string>>(() => new Set());
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
        title: task?.title || row.paneName || row.label || row.target,
        meta: task ? t(`common:status.${task.status}`) : undefined,
        isBlocked,
        row,
      };
    });
  }, [rows, taskById, t]);

  // 完了行（既読状態に関わらず一覧には出続ける — 「既読」はバッジの未読数だけに作用し、
  // 一覧そのものを消さない）。寿命の適用は AgentActivityProvider に一元化されているので、
  // ここでは年齢フィルタを持たない。
  const finishedRows = useMemo(() => rows.filter((r) => r.status === 'finished'), [rows]);

  const unreadFinishedCount = useMemo(
    () => finishedRows.filter((r) => !readKeys.has(readKeyFor(r))).length,
    [finishedRows, readKeys],
  );

  const workingCount = workingGroups.length;

  const handleToggle = () => {
    setOpen((prev) => {
      const next = !prev;
      if (next && finishedRows.length > 0) {
        setReadKeys((cur) => {
          const cutoff = Date.now() - FINISHED_TTL_MS;
          const merged = pruneStaleReadKeys(cur, cutoff);
          for (const r of finishedRows) merged.add(readKeyFor(r));
          return merged;
        });
      }
      return next;
    });
  };

  const handleWorkingRowOpen = (group: WorkingGroup) => {
    openActivityTarget(
      { taskId: group.taskId, serverName: group.row.serverName, target: group.row.target, projectId: group.projectId },
      group.title,
      openTask,
      connectPane,
    );
    setOpen(false);
  };

  const handleFinishedRowOpen = (row: ActiveWindowRow) => {
    openActivityTarget(
      { taskId: row.taskId, serverName: row.serverName, target: row.target, projectId: row.projectId },
      row.label || row.paneName || row.target,
      openTask,
      connectPane,
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
            bottom: `calc(${BAR_HEIGHT}px + env(safe-area-inset-bottom))`,
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
              <div style={sectionHeaderStyle}>{t('workspace:activityPill.finishedSection', { count: finishedRows.length })}</div>
              {finishedRows.map((row) => (
                <button key={row.key} type="button" className="row-hover" onClick={() => handleFinishedRowOpen(row)} style={rowButtonStyle}>
                  <FinishedIndicator />
                  <span style={rowTitleStyle}>{row.label || row.paneName || row.target}</span>
                  {row.finishedAt != null && (
                    <span style={{ flexShrink: 0, fontSize: 'var(--font-2xs)', color: 'var(--success)' }}>
                      {formatRelativeTime(row.finishedAt)}
                    </span>
                  )}
                </button>
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
                {healthReasonText(worstHealth, worstMemUsedPercent, t)}
              </span>
            </div>
            {worstMeasurement && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '0 8px 8px' }}>
                <MiniHealthRow label="MEM" value={worstMemUsedPercent ?? 0} warning={(worstMemUsedPercent ?? 0) >= 60} />
                <MiniHealthRow
                  label="CPU"
                  value={Math.min(100, worstMeasurement.loadPerCore * 100)}
                  warning={worstMeasurement.loadPerCore > 1.5}
                />
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
            height: BAR_HEIGHT,
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
