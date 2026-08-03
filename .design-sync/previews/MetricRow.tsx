import { MetricRow } from '@azito/frontend';

export const ServerResources = () => (
  <div
    style={{
      display: 'grid',
      gap: 8,
      maxWidth: 340,
      padding: '10px 12px',
      background: 'var(--bg-card)',
      border: '1px solid var(--border)',
      borderRadius: 8,
    }}
  >
    <MetricRow label="CPU" value={23} detail="23% · load 1.84" warning={false} meterWidth={110} />
    <MetricRow label="MEM" value={71} detail="22.7 / 32.0 GB" warning={false} meterWidth={110} />
    <MetricRow label="DISK" value={92} detail="235 / 256 GB" warning meterWidth={110} />
  </div>
);
