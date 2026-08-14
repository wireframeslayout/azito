interface ResourceMeterProps {
  value: number;
  width?: number | string;
  /** バーの太さ(px)。デフォルト6。SP フローティングピルのミニメーター（Issue #338 T11 P1）は4を使う。 */
  height?: number;
  warning?: boolean;
}

export function ResourceMeter({ value, width = 110, height = 6, warning }: ResourceMeterProps) {
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
        height,
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
