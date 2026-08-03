import { StatusDot } from '@azito/frontend';

const states = ['idle', 'busy', 'error', 'offline', 'running', 'done', 'failed'] as const;

export const AllStates = () => (
  <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
    {states.map((s) => (
      <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
        <StatusDot status={s} />
        {s}
      </span>
    ))}
  </div>
);
