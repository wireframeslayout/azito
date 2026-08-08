import { StatusBadge } from '@azito/frontend';

export const TaskStatuses = () => (
  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
    <StatusBadge status="open" />
    <StatusBadge status="in_progress" />
    <StatusBadge status="waiting_input" />
    <StatusBadge status="review" />
    <StatusBadge status="done" />
    <StatusBadge status="failed" />
    <StatusBadge status="archived" />
  </div>
);

export const RunningWithPhase = () => (
  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
    <StatusBadge status="running" currentPhase="planning" />
    <StatusBadge status="running" currentPhase="implementing" />
    <StatusBadge status="running" currentPhase="reviewing" />
    <StatusBadge status="running" currentPhase="pushing" />
  </div>
);
