import { useTranslation } from 'react-i18next';
import { useApi } from '../../../hooks/useApi';
import { formatRelativeTime } from '../../../utils/time';
import { Badge, Button, EmptyState, ListRow, ListRowGroup, LoadingState, SectionHeader } from '../../ui';
import type { BadgeTone } from '../../ui';

const AUDIT_LOG_LIMIT = 100;

interface AuditLogRow {
  id: number;
  ts: string;
  actorClass: 'operator' | 'task' | 'trigger' | 'runtime' | 'agent';
  actorId: number | null;
  event: string;
  detail: Record<string, unknown> | null;
}

const ACTOR_TONE: Record<AuditLogRow['actorClass'], BadgeTone> = {
  operator: 'accent',
  task: 'purple',
  trigger: 'purple',
  runtime: 'neutral',
  agent: 'neutral',
};

function actorLabel(row: AuditLogRow): string {
  return row.actorId != null ? `${row.actorClass}:${row.actorId}` : row.actorClass;
}

/**
 * Issue #28 Phase D-4 (design v3 §10 "可視化" — minimal read-only view, no
 * filtering): the most recent `audit_log` rows, operator-only
 * (`GET /api/audit-log` has no `config.auth`, so `evaluateRouteAuth()`
 * default-denies every non-operator principal — this section is only ever
 * reachable by a browser holding the operator UI token in the first place).
 */
export default function AuditLogSection() {
  const { t } = useTranslation('settings');
  const { data, loading, error, refresh } = useApi<AuditLogRow[]>(`/audit-log?limit=${AUDIT_LOG_LIMIT}`);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <p style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', margin: 0 }}>
        {t('auditLog.description', { count: AUDIT_LOG_LIMIT })}
      </p>

      {loading && <LoadingState />}

      {!loading && error && (
        <EmptyState
          title={t('auditLog.loadError')}
          description={error}
          action={<Button size="sm" onClick={refresh}>{t('common:actions.retry')}</Button>}
        />
      )}

      {!loading && !error && data && data.length === 0 && (
        <EmptyState title={t('auditLog.empty')} />
      )}

      {!loading && !error && data && data.length > 0 && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <SectionHeader>{t('auditLog.recentEvents', { count: data.length })}</SectionHeader>
            <Button size="sm" onClick={refresh}>{t('common:actions.refresh')}</Button>
          </div>
          <ListRowGroup>
            {data.map((row) => (
              <ListRow
                key={row.id}
                size="sm"
                title={row.event}
                description={row.detail ? JSON.stringify(row.detail) : undefined}
                chips={<Badge tone={ACTOR_TONE[row.actorClass]}>{actorLabel(row)}</Badge>}
                rightActions={
                  <span title={row.ts} style={{ fontSize: 'var(--font-xs)', color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
                    {formatRelativeTime(row.ts)}
                  </span>
                }
              />
            ))}
          </ListRowGroup>
        </>
      )}
    </div>
  );
}
