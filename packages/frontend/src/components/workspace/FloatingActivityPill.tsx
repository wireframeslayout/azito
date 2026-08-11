import { useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useActiveWindowRows } from '../../hooks/useActiveWindowRows';
import type { ActiveWindowRow } from '../../hooks/useActiveWindowRows';
import { useClickOutside } from '../../hooks/useClickOutside';
import { BrailleSpinner, BlockedDot, FinishedIndicator } from '../ui/WindowActivityIndicator';
import { formatRelativeTime } from '../../utils/time';
import { openActivityTarget } from '../../lib/activityOpen';
import { groupRunningRows, readKeyFor, pruneStaleReadKeys } from '../../lib/activityPillLogic';
import type { Task } from '../../pages/workspace/types';
import { HealthDot, HEALTH_CHIP_TOKENS } from '../statusbar/HealthDot';
import { ResourceMeter } from '../statusbar/ResourceMeter';
import { healthReasonText } from '../statusbar/ResourceDropdown';
import { getHealthLevel, getWorstHealth, useServerResourcesContext } from '../../hooks/useServerResources';
import { ServerHealthSheet } from './ServerHealthSheet';

// SP常設フローティングピル（Issue #69 T2 / モック S6-14, F2）。データは useAgentActivity
// （useActiveWindowRows 経由）のみを参照し、新規ポーリングは持たない。ワークスペースのタブ有無に
// 関わらず常設し、右下から文脈フッター（端末クイックキーバー/チャット入力バー、T3が公開する
// --sp-footer-h）の上へ退避する。集計ロジック（グループ化・既読ID）は lib/activityPillLogic.ts
// に切り出してユニットテストしている。
// Issue #338 T11 P1: サーバーヘルスをピルに同梱する。データは useServerResourcesContext
// （Layout 側の既存ポーリングを共有・新規ポーリング禁止）、ヘルス判定は getHealthLevel/
// getWorstHealth（ResourceDropdown/ServerHealthSheet と共有・コピー禁止）を再利用する。

const FINISHED_WINDOW_MS = 60 * 60 * 1000;

interface FloatingActivityPillProps {
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

export function FloatingActivityPill({ allTasks, openTask, connectPane }: FloatingActivityPillProps) {
  const { t } = useTranslation(['workspace', 'common']);
  const { rows } = useActiveWindowRows();
  const [open, setOpen] = useState(false);
  // セッション内既読管理（spec: localStorage不要）。ポップオーバーを開いた時点の完了行キーを
  // 既読にし、以後ピル/リストのカウントから外す。shared な dismissFinished（他画面の
  // ActiveWindowsSection 等にも影響する）とは別系統に保つ。
  const [readKeys, setReadKeys] = useState<Set<string>>(() => new Set());
  const [healthOpen, setHealthOpen] = useState(false);
  const containerRef = useClickOutside<HTMLDivElement>(() => setOpen(false));

  // サーバーヘルス（Issue #338 T11 P1）。複数サーバーは最悪値を代表として使う。
  const servers = useServerResourcesContext();
  const worstHealth = getWorstHealth(servers.map((s) => getHealthLevel(s.measurement)));
  const worstServer = servers.find((s) => getHealthLevel(s.measurement) === worstHealth) ?? null;
  const worstMeasurement = worstServer?.measurement ?? null;
  const worstMemUsedPercent = worstMeasurement ? 100 - worstMeasurement.memAvailablePercent : null;

  const taskById = useMemo(() => new Map(allTasks.map((tk) => [tk.id, tk])), [allTasks]);

  const workingGroups = useMemo<WorkingGroup[]>(() => {
    // グループ化・blocked集約（複数ウィンドウを持つグループは全行を見る）は lib/activityPillLogic
    // の groupRunningRows に切り出し済み。ここではタイトル・メタ情報の算出のみ行う。
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

  // 直近1時間の完了行（既読状態に関わらず、開いている間・再度開いた時も一覧には出続ける —
  // 「既読」はバッジの未読数だけに作用し、一覧そのものを消さない）。
  const finishedRows = useMemo(() => {
    const cutoff = Date.now() - FINISHED_WINDOW_MS;
    return rows.filter((r) => r.status === 'finished' && (r.finishedAt ?? 0) >= cutoff);
  }, [rows]);

  // ピルのバッジに出す未読数（既読管理: ポップオーバーを開いたら既読にし、以後この数から除外する）。
  const unreadFinishedCount = useMemo(
    () => finishedRows.filter((r) => !readKeys.has(readKeyFor(r))).length,
    [finishedRows, readKeys],
  );

  const workingCount = workingGroups.length;
  // 完全アイドル（稼働0・未読完了0）— 静止グリフ表示に切り替える境界（Issue #338 T9 #5:
  // 以前はこの状態でピル自体を非表示にしていたが、常設に変更）。
  const isIdle = workingCount === 0 && unreadFinishedCount === 0;

  const handleToggle = () => {
    setOpen((prev) => {
      const next = !prev;
      if (next && finishedRows.length > 0) {
        setReadKeys((cur) => {
          const cutoff = Date.now() - FINISHED_WINDOW_MS;
          // 時間窓から外れた既読IDは prune し、無期限に肥大化しないようにする。
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
    <div
      ref={containerRef}
      style={{
        position: 'fixed',
        right: 'var(--space-3)',
        // フッター（クイックキーバー/チャット入力バー）の実測高（--sp-footer-h）は既に
        // safe-area 分を含んでいる（各バーが padding-bottom へ env(safe-area-inset-bottom) を
        // 積んだ上でボーダーボックスを測っている）。フッター非表示時（--sp-footer-h: 0px）は
        // ピル自身が safe-area 分を確保する必要があるため、両者を加算せず max() で選ぶ
        // （Issue #338 T5: 表示中は二重加算で必要以上に浮いてしまっていた）。
        bottom: 'calc(var(--space-3) + max(var(--sp-footer-h, 0px), env(safe-area-inset-bottom)))',
        zIndex: 110,
      }}
    >
      {open && (
        <div
          role="dialog"
          aria-label={t('workspace:activityPill.ariaLabel')}
          style={{
            position: 'absolute',
            bottom: 'calc(100% + var(--space-2))',
            right: 0,
            minWidth: 220,
            maxWidth: 280,
            maxHeight: '60vh',
            overflowY: 'auto',
            background: 'var(--bg-elevated)',
            borderRadius: 'var(--radius-lg)',
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

          {/* サーバーヘルス節（Issue #338 T11 P1）。アイドル時（稼働0・未読完了0）でも表示する。 */}
          <section style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between', gap: 4, padding: '4px 8px 6px' }}>
              <span style={{ ...sectionHeaderStyle, padding: 0, whiteSpace: 'nowrap' }}>{t('workspace:mobile.serverHealth')}</span>
              <span
                style={{
                  fontSize: 'var(--font-2xs)',
                  fontWeight: 600,
                  padding: '2px 8px',
                  borderRadius: 'var(--radius-full)',
                  background: HEALTH_CHIP_TOKENS[worstHealth].bg,
                  color: HEALTH_CHIP_TOKENS[worstHealth].fg,
                  flexShrink: 0,
                  whiteSpace: 'nowrap',
                }}
              >
                {healthReasonText(worstHealth, worstMemUsedPercent, t)}
              </span>
            </div>
            {worstMeasurement && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '0 8px 8px' }}>
                <PillHealthMiniRow label="MEM" value={worstMemUsedPercent ?? 0} warning={(worstMemUsedPercent ?? 0) >= 60} />
                <PillHealthMiniRow
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
          gap: 6,
          height: 40,
          padding: '0 var(--space-3)',
          background: 'var(--bg-elevated)',
          border: 'none',
          borderRadius: 'var(--radius-full)',
          boxShadow: 'var(--shadow-2)',
          color: 'var(--text)',
          fontSize: 'var(--font-sm)',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        {workingCount > 0 && <span className="aw-sweep-overlay" aria-hidden="true" />}
        {workingCount > 0 && (
          <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <BrailleSpinner />
            <span>{workingCount}</span>
          </span>
        )}
        {unreadFinishedCount > 0 && (
          <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {workingCount > 0 && <span aria-hidden="true" style={{ color: 'var(--text-dim)' }}>·</span>}
            <span aria-hidden="true" style={{ color: 'var(--success)' }}>&#10003;</span>
            <span style={{ color: 'var(--success)' }}>{unreadFinishedCount}</span>
          </span>
        )}
        {isIdle && (
          <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--text-dim)' }}>
            <span aria-hidden="true">⠿</span>
            <span>0</span>
          </span>
        )}
        {/* サーバーヘルスドット（Issue #338 T11 P1）。アイドル時でも常に表示する。 */}
        <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span aria-hidden="true" style={{ color: 'var(--text-dim)' }}>&middot;</span>
          <HealthDot level={worstHealth} size={8} />
        </span>
      </button>

      <ServerHealthSheet open={healthOpen} onClose={() => setHealthOpen(false)} />
    </div>
  );
}

function PillHealthMiniRow({ label, value, warning }: { label: string; value: number; warning: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: 'var(--mono)', fontSize: 'var(--font-xs)', color: 'var(--text-dim)' }}>
      <span style={{ minWidth: 30, color: 'var(--text)', fontWeight: 600 }}>{label}</span>
      <ResourceMeter value={value} warning={warning} width={64} height={4} />
      <span style={{ marginLeft: 'auto' }}>{Math.round(Math.max(0, Math.min(100, value)))}%</span>
    </div>
  );
}
