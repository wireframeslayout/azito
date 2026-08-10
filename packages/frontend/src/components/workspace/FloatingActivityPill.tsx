import { useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useActiveWindowRows } from '../../hooks/useActiveWindowRows';
import type { ActiveWindowRow } from '../../hooks/useActiveWindowRows';
import { useClickOutside } from '../../hooks/useClickOutside';
import { BrailleSpinner, BlockedDot, FinishedIndicator } from '../ui/WindowActivityIndicator';
import { formatRelativeTime } from '../../utils/time';
import { openActivityTarget } from '../../lib/activityOpen';
import type { Task } from '../../pages/workspace/types';

// SP常設フローティングピル（Issue #69 T2 / モック S6-14, F2）。データは useAgentActivity
// （useActiveWindowRows 経由）のみを参照し、新規ポーリングは持たない。ワークスペースのタブ有無に
// 関わらず常設し、右下から文脈フッター（端末クイックキーバー/チャット入力バー、T3が公開する
// --sp-footer-h）の上へ退避する。

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
  const containerRef = useClickOutside<HTMLDivElement>(() => setOpen(false));

  const taskById = useMemo(() => new Map(allTasks.map((tk) => [tk.id, tk])), [allTasks]);

  const workingGroups = useMemo<WorkingGroup[]>(() => {
    const map = new Map<string, WorkingGroup>();
    for (const row of rows) {
      if (row.status !== 'running') continue;
      const groupKey = row.taskId != null ? `task:${row.taskId}` : `window:${row.key}`;
      if (map.has(groupKey)) continue;
      const task = row.taskId != null ? taskById.get(row.taskId) : undefined;
      map.set(groupKey, {
        key: groupKey,
        taskId: row.taskId,
        projectId: row.projectId,
        title: task?.title || row.paneName || row.label || row.target,
        meta: task ? t(`common:status.${task.status}`) : undefined,
        isBlocked: row.activityStatus === 'blocked',
        row,
      });
    }
    return Array.from(map.values());
  }, [rows, taskById, t]);

  // 直近1時間の完了行（既読状態に関わらず、開いている間・再度開いた時も一覧には出続ける —
  // 「既読」はバッジの未読数だけに作用し、一覧そのものを消さない）。
  const finishedRows = useMemo(() => {
    const cutoff = Date.now() - FINISHED_WINDOW_MS;
    return rows.filter((r) => r.status === 'finished' && (r.finishedAt ?? 0) >= cutoff);
  }, [rows]);

  // ピルのバッジに出す未読数（既読管理: ポップオーバーを開いたら既読にし、以後この数から除外する）。
  const unreadFinishedCount = useMemo(
    () => finishedRows.filter((r) => !readKeys.has(r.key)).length,
    [finishedRows, readKeys],
  );

  const workingCount = workingGroups.length;

  // 非表示条件: 稼働も未読の完了もない場合は畳む。展開中（open）は対象外 —
  // 開いた瞬間に既読化（unreadFinishedCount→0）してもポップオーバーごと消えないようにする。
  if (!open && workingCount === 0 && unreadFinishedCount === 0) return null;

  const handleToggle = () => {
    setOpen((prev) => {
      const next = !prev;
      if (next && finishedRows.length > 0) {
        setReadKeys((cur) => {
          const merged = new Set(cur);
          for (const r of finishedRows) merged.add(r.key);
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
        bottom: 'calc(var(--space-3) + var(--sp-footer-h, 0px) + env(safe-area-inset-bottom))',
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
      </button>
    </div>
  );
}
