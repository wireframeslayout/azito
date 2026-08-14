import { useTranslation } from 'react-i18next';
import { Chip } from '../ui/Chip';
import { BrailleSpinner, BlockedDot } from '../ui/WindowActivityIndicator';
import { formatRelativeTime } from '../../utils/time';
import type {
  ActivityDecidedBy,
  ActivityDecidedState,
  ActivityDiagnosticRow,
} from '../../hooks/useActivityDiagnostics';

// 稼働検知診断テーブルのセル部品。Settings → System の全件表（ActivityDiagnosticsPanel）と
// ステータスバーのフローティング表（ActivityDiagnosticsDropdown）が同じ表記で読めるよう、
// ラベル辞書・状態グリフ・Tier チップ・最終遷移セルをここに集約する。

export const TIER_LABEL_KEYS: Record<ActivityDecidedBy, string> = {
  tier0_supervisor: 'activityDiagnostics.tier0',
  tier1_hook: 'activityDiagnostics.tier1',
  tier2_title: 'activityDiagnostics.tier2',
  tier3_heuristic: 'activityDiagnostics.tier3',
  tier4_probe: 'activityDiagnostics.tier4',
  none: 'activityDiagnostics.tierNone',
};

export const STATE_LABEL_KEYS: Record<ActivityDecidedState, string> = {
  working: 'activityDiagnostics.stateWorking',
  blocked: 'activityDiagnostics.stateBlocked',
  idle: 'activityDiagnostics.stateIdle',
  offline: 'activityDiagnostics.stateOffline',
  none: 'activityDiagnostics.stateNone',
};

export const DIM: React.CSSProperties = { color: 'var(--text-dim)' };
export const MONO: React.CSSProperties = {
  fontFamily: 'var(--mono)', fontSize: 'var(--font-sm)', color: 'var(--text)',
};

/**
 * idle/offline/none 用の中立ドット（working/blocked は既存の稼働グリフを再利用する）。
 * hollow は「観測できていない」= 面を塗らない、という区別に使う。
 */
export function StateDot({ tone, hollow = false }: { tone: string; hollow?: boolean }) {
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

export function StateCell({ state }: { state: ActivityDecidedState }) {
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

/** 判定 Tier のチップ（Tier 0 なら accent）＋ 状態だけを精緻化した下位 Tier の注記。 */
export function TierCell({ row }: { row: ActivityDiagnosticRow }) {
  const { t } = useTranslation('settings');
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
      <Chip tone={row.decidedBy === 'tier0_supervisor' ? 'accent' : 'default'}>
        {t(TIER_LABEL_KEYS[row.decidedBy])}
      </Chip>
      {/* 判定 Tier は奪わずに状態だけを精緻化した下位 Tier（Tier0 idle + Tier2 blocked）。 */}
      {row.refinedBy && (
        <span style={{ ...DIM, fontSize: 'var(--font-2xs)', whiteSpace: 'nowrap' }}>
          {t('activityDiagnostics.refinedBlocked', { tier: t(TIER_LABEL_KEYS[row.refinedBy]) })}
        </span>
      )}
    </span>
  );
}

export function TransitionCell({ row }: { row: ActivityDiagnosticRow }) {
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

/** ウィンドウ列（tmux ターゲット＋ サーバー名・タスク番号）。 */
export function WindowCell({ row }: { row: ActivityDiagnosticRow }) {
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
      <span style={MONO}>{row.target}</span>
      <span style={{ ...DIM, fontSize: 'var(--font-2xs)' }}>
        {row.serverName}
        {row.taskId != null && ` · #${row.taskId}`}
      </span>
    </span>
  );
}
