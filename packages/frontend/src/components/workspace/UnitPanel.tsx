import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { paths } from '../../paths';
import { Button, Chip, EyebrowBack, ListRow, ListRowGroup } from '../ui';
import { Icon } from '../ui/Icon';
import { StatusDot } from '../StatusBadge';
import { useApi } from '../../hooks/useApi';
import { useIsMobile } from '../../hooks/useIsMobile';
import { timeAgo } from '../../utils/time';
import { summarizePhaseConfig, getPhaseLabel } from '../../lib/taskPhases';
import { useUnitTypes, findUnitType } from '../../hooks/useUnitTypes';
import type { RunningOperation, Task, Unit } from '../../pages/workspace/types';

interface UnitPanelProps {
  unitId: number;
  allUnits: Unit[];
  onOpenTask: (t: Task) => void;
  /** Eyebrow back affordance: navigates to the Units list tab (same idiom as TaskPanel's onBack; the detail tab itself stays open). */
  onBack: () => void;
  connectPane: (serverName: string, target: string) => void;
}

const STATUS_FILTER_KEYS: Record<string, string> = {
  open: 'statusFilter.open',
  running: 'statusFilter.running',
  phase_review: 'statusFilter.planReview',
  review: 'statusFilter.review',
  waiting_input: 'statusFilter.waitingInput',
  in_progress: 'statusFilter.inProgress',
  done: 'statusFilter.done',
  failed: 'statusFilter.failed',
};

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 'var(--font-xs)', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
  color: 'var(--text-dim)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6,
};

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/**
 * Read-only Unit overview shown in the workspace tab (Issue #263 Refine C: absorbs the
 * former standalone UnitDetail page). Units are global, so assigned tasks are fetched
 * cross-project via GET /api/tasks?unit_id= rather than filtered from the current
 * project's task list.
 */
export default function UnitPanel({ unitId, allUnits, onOpenTask, onBack, connectPane }: UnitPanelProps) {
  const { t } = useTranslation('units');
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { unitTypes } = useUnitTypes();
  const unit = allUnits.find((u) => u.id === unitId);
  const [unitTasks, setUnitTasks] = useState<Task[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [tasksError, setTasksError] = useState<string | null>(null);
  const { data: runningOps } = useApi<RunningOperation[]>('/operations');

  useEffect(() => {
    let cancelled = false;
    setTasksLoading(true);
    setTasksError(null);
    api<Task[]>(`/tasks?unit_id=${unitId}`)
      .then((list) => { if (!cancelled) setUnitTasks(list); })
      .catch((err: unknown) => { if (!cancelled) setTasksError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setTasksLoading(false); });
    return () => { cancelled = true; };
  }, [unitId]);

  if (!unit) return <div style={{ padding: 24, color: 'var(--text-dim)', background: 'var(--ws-surface)', height: '100%' }}>{t('detail.notFound')}</div>;

  const running = (runningOps || []).filter((op) => op.unitId === unit.id);

  return (
    <div className="mobile-scroll-inset" style={{ overflowY: 'auto', background: 'var(--ws-surface)', height: '100%' }}>
      <PanelHeader unit={unit} isMobile={isMobile} onBack={onBack} onEdit={() => navigate(paths.unitEdit(unit.id))} />

      <div style={{ padding: isMobile ? '12px' : '20px 24px', display: 'flex', flexDirection: 'column', gap: 28 }}>
        {running.length > 0 && (
          <NowRunningSection running={running} unitTasks={unitTasks} connectPane={connectPane} />
        )}

        <BehaviorSection unit={unit} isMobile={isMobile} unitTypePhases={findUnitType(unitTypes, unit.unitType)?.phases ?? []} />

        <TasksSection
          unitTasks={unitTasks}
          loading={tasksLoading}
          error={tasksError}
          onOpenTask={onOpenTask}
        />
      </div>
    </div>
  );
}

function PanelHeader({ unit, isMobile, onBack, onEdit }: { unit: Unit; isMobile: boolean; onBack: () => void; onEdit: () => void; }) {
  const { t } = useTranslation('units');
  const oneliner = [
    `${unit.workerType ?? '—'}${unit.workerModel ? ` / ${unit.workerModel}` : ''}`,
    unit.workerExecutionMode,
  ].join(' · ');

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
      padding: isMobile ? '8px 12px' : '14px 24px',
      borderBottom: '1px solid var(--border)', background: 'var(--bg-card)', flexShrink: 0,
    }}>
      <div style={{ minWidth: 0 }}>
        <EyebrowBack label={t('backLabel')} onBack={onBack} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
          <div style={{
            width: 34, height: 34, borderRadius: 'var(--radius-md)', flexShrink: 0,
            background: 'var(--bg)', border: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 'var(--font-md)', fontWeight: 700, color: 'var(--accent)',
          }}>
            {initials(unit.name)}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 'var(--font-xl)', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {unit.name}
            </div>
            <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {oneliner}
            </div>
          </div>
        </div>
      </div>
      <Button variant="primary" size="sm" onClick={onEdit} style={{ flexShrink: 0, marginTop: 2 }}>
        {t('detail.editUnit')}
      </Button>
    </div>
  );
}

function NowRunningSection({ running, unitTasks, connectPane }: {
  running: RunningOperation[];
  unitTasks: Task[];
  connectPane: (serverName: string, target: string) => void;
}) {
  const { t } = useTranslation('units');
  return (
    <div>
      <h3 style={{ ...sectionHeaderStyle, color: 'var(--success)' }}>
        <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)', display: 'inline-block' }} />
        {t('sections.nowRunning', { count: running.length })}
      </h3>
      <ListRowGroup>
        {running.map((op, i) => {
          const task = unitTasks.find((tt) => tt.id === op.taskId);
          return (
            <ListRow
              key={`${op.taskId}-${i}`}
              title={task ? `#${task.id} ${task.title}` : t('taskList.taskRef', { id: op.taskId })}
              description={task ? `${STATUS_FILTER_KEYS[task.status] ? t(STATUS_FILTER_KEYS[task.status]) : task.status} · ${op.target}` : op.target}
              rightActions={
                <Button size="sm" onClick={() => connectPane(op.serverName, op.target)}>{t('terminal')}</Button>
              }
            />
          );
        })}
      </ListRowGroup>
    </div>
  );
}

function StatCard({ label, value, sub, span }: { label: string; value: React.ReactNode; sub?: React.ReactNode; span: number }) {
  return (
    <div style={{
      gridColumn: `span ${span}`,
      background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
      padding: '12px 14px', minWidth: 0,
    }}>
      <div style={{ fontSize: 'var(--font-2xs)', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-dim)' }}>
        {label}
      </div>
      <div style={{ fontSize: 'var(--font-base)', fontWeight: 600, marginTop: 4, overflowWrap: 'break-word' }}>
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 'var(--font-sm)', color: 'var(--text-dim)', marginTop: 2 }}>{sub}</div>
      )}
    </div>
  );
}

function subagentLine(label: string, cfg: Unit['implementSubagent'], t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!cfg || !cfg.enabled) return t('subagent.none', { label });
  return `${label} → ${cfg.provider}/${cfg.model}`;
}

function PhaseSidekickChips({ phaseConfig, phases }: { phaseConfig: Unit['phaseConfig']; phases: Array<{ name: string; label: string }> }) {
  const { t } = useTranslation('units');
  if (!phaseConfig) return <Chip>{t('phaseSidekick.defaultConfig')}</Chip>;
  const { disabledPhases, customizedPhases } = summarizePhaseConfig(phaseConfig, phases);
  if (disabledPhases.length === 0 && customizedPhases.length === 0) return <Chip>{t('phaseSidekick.defaultConfig')}</Chip>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {disabledPhases.map((p) => <Chip key={`disabled-${p}`} tone="red">{getPhaseLabel(phases, p)}: off</Chip>)}
      {customizedPhases.map((p) => <Chip key={`custom-${p}`} tone="purple">{getPhaseLabel(phases, p)}: custom</Chip>)}
    </div>
  );
}

function BehaviorSection({ unit, isMobile, unitTypePhases }: { unit: Unit; isMobile: boolean; unitTypePhases: Array<{ name: string; label: string }> }) {
  const { t } = useTranslation('units');
  const [expanded, setExpanded] = useState(false);
  const gridCols = isMobile ? 'repeat(2, 1fr)' : 'repeat(6, 1fr)';
  const fullSpan = isMobile ? 2 : 3;
  const halfSpan = 2;

  return (
    <div>
      <h3 style={sectionHeaderStyle}>{t('sections.behavior')}</h3>
      <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 10 }}>
        <StatCard
          label={t('stats.worker')}
          value={`${unit.workerType ?? '—'}${unit.workerModel ? ` / ${unit.workerModel}` : ''}`}
          sub={unit.workerExtraArgs || undefined}
          span={halfSpan}
        />
        <StatCard
          label={t('stats.execution')}
          value={unit.workerExecutionMode}
          span={halfSpan}
        />
        <StatCard
          label={t('stats.selfReview')}
          value={t('stats.selfReviewMax', { count: unit.selfReviewMaxAttempts ?? 2 })}
          span={isMobile ? 2 : halfSpan}
        />
        <StatCard
          label={t('stats.subagents')}
          value={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span>{subagentLine(t('stats.implement'), unit.implementSubagent, t)}</span>
              <span>{subagentLine(t('stats.review'), unit.reviewSubagent, t)}</span>
            </div>
          }
          span={fullSpan}
        />
        <StatCard
          label={t('sections.phaseSidekicks')}
          value={<PhaseSidekickChips phaseConfig={unit.phaseConfig} phases={unitTypePhases} />}
          span={fullSpan}
        />
      </div>

      <div style={{ marginTop: 10 }}>
        {unit.systemPrompt ? (
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
            <button
              type="button"
              onClick={() => setExpanded((e) => !e)}
              aria-expanded={expanded}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer',
                font: 'inherit', color: 'inherit', textAlign: 'left',
              }}
            >
              <span style={{ fontSize: 'var(--font-md)', fontWeight: 600 }}>{t('sections.systemPrompt')}</span>
              <span aria-hidden="true" style={{ display: 'inline-flex', color: 'var(--text-dim)' }}><Icon name="chevron-down" size={14} rotate={expanded ? 180 : 0} /></span>
            </button>
            {expanded && (
              <pre style={{
                margin: 0, padding: '0 14px 14px', fontSize: 'var(--font-sm)', whiteSpace: 'pre-wrap',
                color: 'var(--text-dim)',
              }}>
                {unit.systemPrompt}
              </pre>
            )}
          </div>
        ) : (
          <div style={{ fontSize: 'var(--font-md)', color: 'var(--text-dim)', padding: '10px 14px', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
            {t('sections.systemPromptEmpty')}
          </div>
        )}
      </div>
    </div>
  );
}

function TasksSection({ unitTasks, loading, error, onOpenTask }: {
  unitTasks: Task[];
  loading: boolean;
  error: string | null;
  onOpenTask: (t: Task) => void;
}) {
  const { t } = useTranslation('units');
  const [activeFilters, setActiveFilters] = useState<Set<string>>(new Set());

  const statusCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of unitTasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
    return counts;
  }, [unitTasks]);

  const sorted = useMemo(() => {
    const filtered = activeFilters.size === 0 ? unitTasks : unitTasks.filter((task) => activeFilters.has(task.status));
    return [...filtered].sort((a, b) => {
      const aRunning = a.status === 'in_progress' ? 1 : 0;
      const bRunning = b.status === 'in_progress' ? 1 : 0;
      if (aRunning !== bRunning) return bRunning - aRunning;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }, [unitTasks, activeFilters]);

  const toggleFilter = (status: string) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status); else next.add(status);
      return next;
    });
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        <h3 style={{ ...sectionHeaderStyle, marginBottom: 0 }}>{t('sections.tasks', { count: unitTasks.length })}</h3>
        {statusCounts.size > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {[...statusCounts.entries()].map(([status, count]) => (
              <button
                key={status}
                type="button"
                onClick={() => toggleFilter(status)}
                aria-pressed={activeFilters.has(status)}
                style={{
                  border: activeFilters.has(status) ? '1px solid var(--accent)' : '1px solid var(--border)',
                  background: activeFilters.has(status) ? 'var(--accent-a08)' : 'var(--bg-card)',
                  color: activeFilters.has(status) ? 'var(--accent)' : 'var(--text-dim)',
                  borderRadius: 'var(--radius-full)', padding: '3px 10px', fontSize: 'var(--font-xs)', fontWeight: 500,
                  cursor: 'pointer', fontVariantNumeric: 'tabular-nums',
                }}
              >
                {STATUS_FILTER_KEYS[status] ? t(STATUS_FILTER_KEYS[status]) : status} ({count})
              </button>
            ))}
          </div>
        )}
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-dim)', fontSize: 'var(--font-md)' }}>{t('taskList.loading')}</div>
      ) : error ? (
        <div role="alert" style={{
          padding: '8px 12px', borderRadius: 'var(--radius-sm)', fontSize: 'var(--font-md)',
          background: 'var(--danger-a15)', border: '1px solid var(--danger-a35)', color: 'var(--danger)',
        }}>
          {t('taskList.loadFailed', { error })}
        </div>
      ) : sorted.length === 0 ? (
        <div style={{ color: 'var(--text-dim)', fontSize: 'var(--font-md)' }}>{t('taskList.noTasks')}</div>
      ) : (
        <ListRowGroup>
          {sorted.map((task) => (
            <ListRow
              key={task.id}
              title={
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <StatusDot status={task.status} />
                  {`#${task.id} ${task.title}`}
                </span>
              }
              chips={<Chip>{timeAgo(task.updatedAt)}</Chip>}
              onClick={() => onOpenTask(task)}
            />
          ))}
        </ListRowGroup>
      )}
    </div>
  );
}
