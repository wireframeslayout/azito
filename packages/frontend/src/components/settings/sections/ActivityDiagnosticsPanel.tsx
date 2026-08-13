import { useTranslation } from 'react-i18next';
import { Chip } from '../../ui/Chip';
import { BrailleSpinner, BlockedDot } from '../../ui/WindowActivityIndicator';
import { formatRelativeTime } from '../../../utils/time';
import {
  useActivityDiagnostics,
  type ActivityDecidedBy,
  type ActivityDecidedState,
  type ActivityDiagnosticRow,
} from '../../../hooks/useActivityDiagnostics';

const TIER_LABEL_KEYS: Record<ActivityDecidedBy, string> = {
  tier0_supervisor: 'activityDiagnostics.tier0',
  tier1_hook: 'activityDiagnostics.tier1',
  tier2_title: 'activityDiagnostics.tier2',
  tier3_heuristic: 'activityDiagnostics.tier3',
  tier4_probe: 'activityDiagnostics.tier4',
  none: 'activityDiagnostics.tierNone',
};

const STATE_LABEL_KEYS: Record<ActivityDecidedState, string> = {
  working: 'activityDiagnostics.stateWorking',
  blocked: 'activityDiagnostics.stateBlocked',
  idle: 'activityDiagnostics.stateIdle',
  offline: 'activityDiagnostics.stateOffline',
  none: 'activityDiagnostics.stateNone',
};

const DIM: React.CSSProperties = { color: 'var(--text-dim)' };
const MONO: React.CSSProperties = { fontFamily: 'var(--mono)', fontSize: 'var(--font-sm)', color: 'var(--text)' };

/**
 * idle/offline/none 用の中立ドット（working/blocked は既存の稼働グリフを再利用する）。
 * hollow は「観測できていない」= 面を塗らない、という区別に使う。
 */
function StateDot({ tone, hollow = false }: { tone: string; hollow?: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        width: 8, height: 8, borderRadius: '50%', flexShrink: 0, display: 'inline-block',
        background: hollow ? 'transparent' : tone,
        border: hollow ? `1px solid ${tone}` : 'none',
      }}
    />
  );
}

function StateCell({ state }: { state: ActivityDecidedState }) {
  const { t } = useTranslation('settings');
  const label = t(STATE_LABEL_KEYS[state]);
  const glyph = state === 'working' ? <BrailleSpinner />
    : state === 'blocked' ? <BlockedDot />
      : <StateDot tone="var(--text-dim)" hollow={state !== 'idle'} />;
  const color = state === 'working' ? 'var(--success)'
    : state === 'blocked' ? 'var(--warning)'
      : 'var(--text-dim)';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
      {glyph}
      <span style={{ color, fontSize: 'var(--font-sm)' }}>{label}</span>
    </span>
  );
}

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

function TransitionCell({ row }: { row: ActivityDiagnosticRow }) {
  const { t } = useTranslation('settings');
  const tr = row.lastTransition;
  if (!tr) return <span style={{ ...DIM, fontSize: 'var(--font-sm)' }}>—</span>;
  const label = tr.running
    ? t('activityDiagnostics.transitionStarted')
    : t(`activityDiagnostics.reason.${tr.reason ?? 'unknown'}`);
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, whiteSpace: 'nowrap' }}>
      <span style={{ fontSize: 'var(--font-sm)', color: 'var(--text)' }}>{label}</span>
      <span style={{ ...DIM, fontSize: 'var(--font-2xs)' }}>{formatRelativeTime(tr.at)}</span>
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

  return (
    <section style={{ marginTop: 24 }} aria-labelledby="activity-diagnostics-heading">
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
        {error && (
          <div role="status" style={{
            padding: '8px 12px', background: 'var(--danger-a08)',
            color: 'var(--danger)', fontSize: 'var(--font-sm)',
          }}>
            {t('activityDiagnostics.fetchFailed')}
          </div>
        )}
        {rows === null ? (
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
                    <td>
                      <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
                        <span style={MONO}>{row.target}</span>
                        <span style={{ ...DIM, fontSize: 'var(--font-2xs)' }}>
                          {row.serverName}
                          {row.taskId != null && ` · #${row.taskId}`}
                        </span>
                      </span>
                    </td>
                    <td><StateCell state={row.state} /></td>
                    <td>
                      <Chip tone={row.decidedBy === 'tier0_supervisor' ? 'accent' : 'default'}>
                        {t(TIER_LABEL_KEYS[row.decidedBy])}
                      </Chip>
                    </td>
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
