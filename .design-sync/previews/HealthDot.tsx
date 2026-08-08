import { HealthDot } from '@azito/frontend';

const levels = [
  { level: 'healthy', label: 'server01 · CPU 12%' },
  { level: 'warning', label: 'wakanda · MEM 82%' },
  { level: 'critical', label: 'build-box · DISK 97%' },
  { level: 'update', label: 'hub v0.3.1 available' },
] as const;

export const AllLevels = () => (
  <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
    {levels.map(({ level, label }) => (
      <span key={level} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text)' }}>
        <HealthDot level={level} />
        {label}
      </span>
    ))}
  </div>
);

export const Sizes = () => (
  <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
    {[6, 9, 12].map((s) => (
      <span key={s} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-dim)' }}>
        <HealthDot level="healthy" size={s} />
        {s}px
      </span>
    ))}
  </div>
);
