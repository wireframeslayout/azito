import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Chip } from '../../ui/Chip';
import { Notice } from '../../ui/Notice';
import { formatRelativeTime } from '../../../utils/time';
import {
  DIM,
  StateCell,
  StateDot,
  TierCell,
  TransitionCell,
  WindowCell,
} from '../../activity/activityDiagnosticsCells';
import {
  useActivityDiagnostics,
  type ActivityDiagnosticRow,
} from '../../../hooks/useActivityDiagnostics';

/** ステータスバーのパネルから「全件表示」で飛んでくるときのスクロール先（location.hash）。 */
export const ACTIVITY_DIAGNOSTICS_ANCHOR = 'activity-diagnostics';

function SupervisorCell({ row }: { row: ActivityDiagnosticRow }) {
  const { t } = useTranslation('settings');
  const sv = row.supervisor;
  if (!sv) return <span style={{ ...DIM, fontSize: 'var(--font-sm)' }}>—</span>;

  // 「supervisor は繋がっているのに Tier0 が判定していない」= フレーム未受信、または上位で
  // 別の理由により Tier0 が判定に至っていない状態。ここが一目で分かることがこの表の目的。
  const silent = sv.lastActivityFrameAt === null;
  const notDeciding = !silent && row.decidedBy !== 'tier0_supervisor';

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
        <StateDot tone={sv.ready ? 'var(--success)' : 'var(--warning)'} />
        <span style={{ fontSize: 'var(--font-sm)', color: 'var(--text)' }}>pid {sv.pid}</span>
        {sv.lastReportedState && (
          <Chip tone={sv.lastReportedState === 'active' ? 'green' : 'default'}>
            {sv.lastReportedStatus === 'blocked' ? t('activityDiagnostics.stateBlocked') : sv.lastReportedState}
          </Chip>
        )}
        {!sv.bound && <Chip tone="orange">{t('activityDiagnostics.unbound')}</Chip>}
      </span>
      <span style={{ ...DIM, fontSize: 'var(--font-2xs)', whiteSpace: 'nowrap' }}>
        {silent
          ? t('activityDiagnostics.noFrames')
          : t('activityDiagnostics.lastFrame', { time: formatRelativeTime(sv.lastActivityFrameAt as number) })}
        {notDeciding && ` · ${t('activityDiagnostics.notDeciding')}`}
      </span>
    </span>
  );
}

/**
 * 稼働検知診断: どのウィンドウがどの Tier で判定されているかをライブ表示する読み取り専用パネル。
 * 「supervisor（Tier 0）が実際に検知を担っているか」をログ以外の手段で確認するためのもので、
 * 表示だけで判定には一切影響しない。
 */
export default function ActivityDiagnosticsPanel() {
  const { t } = useTranslation('settings');
  const { rows, error } = useActivityDiagnostics(true);
  const tier0Count = rows?.filter((r) => r.decidedBy === 'tier0_supervisor').length ?? 0;
  const sectionRef = useRef<HTMLElement>(null);
  // 既に /settings/system を開いている状態でも「全件表示」でスクロールできるよう、mount 時では
  // なく location.hash の変化を見る（同一ページ内では hash だけが変わる）。
  const { hash } = useLocation();

  useEffect(() => {
    if (hash !== `#${ACTIVITY_DIAGNOSTICS_ANCHOR}`) return;
    sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [hash]);

  return (
    <section
      ref={sectionRef}
      id={ACTIVITY_DIAGNOSTICS_ANCHOR}
      style={{ marginTop: 24 }}
      aria-labelledby="activity-diagnostics-heading"
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
        <h3
          id="activity-diagnostics-heading"
          style={{ fontSize: 'var(--font-lg)', fontWeight: 600, color: 'var(--text)', margin: 0 }}
        >
          {t('activityDiagnostics.title')}
        </h3>
        {rows !== null && (
          <span style={{ ...DIM, fontSize: 'var(--font-sm)' }}>
            {t('activityDiagnostics.tier0Summary', { count: tier0Count, total: rows.length })}
          </span>
        )}
      </div>
      <p style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)', marginBottom: 12, lineHeight: 1.5 }}>
        {t('activityDiagnostics.description')}
      </p>

      <div style={{
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)', overflow: 'hidden',
      }}>
        {/* 取得済みスナップショットがある場合のみ「前回の表示を継続中」と言える。初回失敗は
            下の専用状態で伝える（Loading と同時に出さない）。 */}
        {error && rows !== null && (
          <Notice tone="danger" style={{ padding: '8px 12px', borderRadius: 0, fontSize: 'var(--font-sm)' }}>
            {t('activityDiagnostics.fetchFailedStale')}
          </Notice>
        )}
        {rows === null && error !== null ? (
          <div role="status" style={{ padding: 24, textAlign: 'center', color: 'var(--danger)', fontSize: 'var(--font-md)' }}>
            {t('activityDiagnostics.fetchFailed')}
          </div>
        ) : rows === null ? (
          <div style={{ padding: 24, textAlign: 'center', ...DIM, fontSize: 'var(--font-md)' }}>
            {t('activityDiagnostics.loading')}
          </div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', ...DIM, fontSize: 'var(--font-md)' }}>
            {t('activityDiagnostics.empty')}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ minWidth: 640 }}>
              <thead>
                <tr>
                  <th scope="col">{t('activityDiagnostics.colWindow')}</th>
                  <th scope="col">{t('activityDiagnostics.colState')}</th>
                  <th scope="col">{t('activityDiagnostics.colTier')}</th>
                  <th scope="col">{t('activityDiagnostics.colSupervisor')}</th>
                  <th scope="col">{t('activityDiagnostics.colTransition')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.serverName}::${row.target}`}>
                    <td><WindowCell row={row} /></td>
                    <td><StateCell state={row.state} /></td>
                    <td><TierCell row={row} /></td>
                    <td><SupervisorCell row={row} /></td>
                    <td><TransitionCell row={row} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
