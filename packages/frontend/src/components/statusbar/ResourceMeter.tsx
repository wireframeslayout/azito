interface ResourceMeterProps {
  value: number;
  width?: number | string;
  warning?: boolean;
}

export function ResourceMeter({ value, width = 110, warning }: ResourceMeterProps) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <span
      role="meter"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
      style={{
        display: 'inline-block',
        width,
        height: 6,
        borderRadius: 'var(--radius-sm)',
        background: 'color-mix(in srgb, var(--border) 60%, transparent)',
        overflow: 'hidden',
        verticalAlign: 1,
      }}
    >
      <span
        style={{
          display: 'block',
          height: '100%',
          width: `${clamped}%`,
          background: warning ? 'var(--warning)' : 'var(--accent)',
          transition: 'width 0.3s ease',
        }}
      />
    </span>
  );
}
