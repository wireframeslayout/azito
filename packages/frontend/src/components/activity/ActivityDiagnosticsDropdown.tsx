import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Chip } from '../ui/Chip';
import { paths } from '../../paths';
import { ACTIVITY_DIAGNOSTICS_ANCHOR } from '../settings/sections/ActivityDiagnosticsPanel';
import { openActivityTarget } from '../../lib/activityOpen';
import { useNotificationCenter } from '../../hooks/useNotificationCenter';
import type { ActivityDiagnosticRow } from '../../hooks/useActivityDiagnostics';
import {
  DIM, MONO, StateCell, StateDot, TierCell, TransitionCell,
} from './activityDiagnosticsCells';
import { isEventDrivenTier } from '../../lib/activityDiagnostics';
import { formatRelativeTime } from '../../utils/time';

// ステータスバー「稼働検知」アイテムのフローティングパネル（Issue #338）。Settings → System の
// 全件表（ActivityDiagnosticsPanel）の圧縮版で、オフライン以外の行だけを出す。データ取得は
// 呼び出し元（StatusBar）が useActivityDiagnostics で一元的に行い、ここは描画に徹する。

interface ActivityDiagnosticsDropdownProps {
  rows: ActivityDiagnosticRow[] | null;
  error: string | null;
  onClose: () => void;
}

/** supervisor 列の圧縮版: 接続ドット＋報告状態＋最終フレームの相対時刻（pid は全件表側のみ）。 */
function CompactSupervisorCell({ row }: { row: ActivityDiagnosticRow }) {
  const { t } = useTranslation('settings');
  const sv = row.supervisor;
  if (!sv) return <span style={{ ...DIM, fontSize: 'var(--font-xs)' }}>—</span>;
  const reported = sv.lastReportedStatus === 'blocked'
    ? t('activityDiagnostics.stateBlocked')
    : sv.lastReportedState ?? t('activityDiagnostics.supervisorConnected');
  const frame = sv.lastActivityFrameAt === null
    ? t('activityDiagnostics.noFrames')
    : t('activityDiagnostics.lastFrame', { time: formatRelativeTime(sv.lastActivityFrameAt) });
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', ...DIM, fontSize: 'var(--font-xs)' }}>
      <StateDot tone={sv.ready ? 'var(--success)' : 'var(--warning)'} />
      {reported} · {frame}
    </span>
  );
}

export function ActivityDiagnosticsDropdown({ rows, error, onClose }: ActivityDiagnosticsDropdownProps) {
  const { t } = useTranslation(['settings', 'common']);
  const navigate = useNavigate();
  // 行クリックの遷移は通知センターの navigation-aware な opener を共有する。ステータスバーは
  // Workspace の外（Layout 直下）にあり、Settings 等のグローバルページ表示中はタブを作っても
  // 画面が切り替わらないため、プロジェクト解決＋ワークスペースへの遷移まで面倒を見る経路が要る。
  const { openTask: openTaskAnywhere, openTerminal } = useNotificationCenter();

  // オフラインは「稼働していない」ことの確認にしか使わず、件数が多くパネルを埋めてしまうので
  // 全件表（Settings）に任せ、ここでは件数だけをフッターで知らせる。
  const activeRows = rows?.filter((r) => r.state !== 'offline') ?? null;
  const offlineCount = (rows?.length ?? 0) - (activeRows?.length ?? 0);
  const eventDrivenCount = activeRows?.filter((r) => isEventDrivenTier(r.decidedBy)).length ?? 0;

  const handleOpenRow = (row: ActivityDiagnosticRow) => {
    openActivityTarget(
      { taskId: row.taskId, serverName: row.serverName, target: row.target },
      row.target,
      (taskId) => openTaskAnywhere(taskId),
      (serverName, target) => openTerminal(serverName, target, row.projectId),
    );
    onClose();
  };

  const handleOpenSettings = () => {
    navigate(`${paths.settings('system')}#${ACTIVITY_DIAGNOSTICS_ANCHOR}`);
    onClose();
  };

  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 14px', borderBottom: '1px solid var(--border)',
      }}>
        <span style={{ fontWeight: 600, fontSize: 'var(--font-sm)', color: 'var(--text)' }}>
          {t('settings:activityDiagnostics.title')}
        </span>
        {activeRows !== null && (
          <Chip tone="accent">
            {t('settings:activityDiagnostics.tier01Summary', { count: eventDrivenCount, total: activeRows.length })}
          </Chip>
        )}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          onClick={handleOpenSettings}
          className="row-hover"
          style={{
            border: 'none', background: 'none', cursor: 'pointer', font: 'inherit',
            fontSize: 'var(--font-xs)', color: 'var(--accent)', padding: '2px 6px',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          {t('settings:activityDiagnostics.openInSettings')}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('common:actions.close')}
          className="row-hover"
          style={{
            border: 'none', background: 'none', cursor: 'pointer', font: 'inherit',
            fontSize: 'var(--font-md)', color: 'var(--text-dim)', padding: '2px 6px',
            borderRadius: 'var(--radius-sm)', lineHeight: 1,
          }}
        >
          ✕
        </button>
      </div>

      {error !== null && activeRows !== null && (
        <div role="status" style={{
          padding: '6px 14px', background: 'var(--danger-a08)',
          color: 'var(--danger)', fontSize: 'var(--font-xs)',
        }}>
          {t('settings:activityDiagnostics.fetchFailedStale')}
        </div>
      )}

      {activeRows === null && error !== null ? (
        <div role="status" style={{ padding: 20, textAlign: 'center', color: 'var(--danger)', fontSize: 'var(--font-sm)' }}>
          {t('settings:activityDiagnostics.fetchFailed')}
        </div>
      ) : activeRows === null ? (
        <div style={{ padding: 20, textAlign: 'center', ...DIM, fontSize: 'var(--font-sm)' }}>
          {t('settings:activityDiagnostics.loading')}
        </div>
      ) : activeRows.length === 0 ? (
        <div style={{ padding: 20, textAlign: 'center', ...DIM, fontSize: 'var(--font-sm)' }}>
          {t('settings:activityDiagnostics.emptyActive')}
        </div>
      ) : (
        <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('settings:activityDiagnostics.colWindow')}</th>
                <th scope="col">{t('settings:activityDiagnostics.colState')}</th>
                <th scope="col">{t('settings:activityDiagnostics.colTier')}</th>
                <th scope="col">{t('settings:activityDiagnostics.colSupervisor')}</th>
                <th scope="col">{t('settings:activityDiagnostics.colTransition')}</th>
              </tr>
            </thead>
            <tbody>
              {activeRows.map((row) => (
                <tr
                  key={`${row.serverName}::${row.target}`}
                  className="aw-diag-row"
                  onClick={() => handleOpenRow(row)}
                  style={{ cursor: 'pointer' }}
                >
                  <td>
                    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
                      {/* 行全体がクリック可能だが、キーボード操作の到達点としてボタンを置く
                          （tr に role="button" を被せるより表のセマンティクスを壊さない）。 */}
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleOpenRow(row); }}
                        // 長いターゲットは折り返す。nowrap にすると 640px の器から最終遷移列が
                        // はみ出して読めなくなるため、識別子は省略せず折り返しで収める。
                        style={{ ...MONO, border: 'none', background: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }}
                      >
                        {row.target}
                      </button>
                      <span style={{ ...DIM, fontSize: 'var(--font-2xs)' }}>
                        {row.serverName}
                        {row.taskId != null && ` · #${row.taskId}`}
                      </span>
                    </span>
                  </td>
                  <td><StateCell state={row.state} /></td>
                  <td><TierCell row={row} /></td>
                  <td><CompactSupervisorCell row={row} /></td>
                  <td><TransitionCell row={row} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {offlineCount > 0 && (
        <div style={{
          padding: '8px 14px', borderTop: '1px solid var(--border)',
          ...DIM, fontSize: 'var(--font-2xs)',
        }}>
          {t('settings:activityDiagnostics.offlineHidden', { count: offlineCount })}
        </div>
      )}
    </div>
  );
}
