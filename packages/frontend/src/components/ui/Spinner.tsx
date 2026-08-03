interface SpinnerProps {
  size?: number;
  color?: string;
  /** Track (background ring) color — defaults to a low-alpha tint of `color`'s usual accent. */
  trackColor?: string;
  /** Freezes the rotation in place (e.g. to signal a stalled/timed-out wait) without unmounting the spinner. */
  paused?: boolean;
}

export function Spinner({ size = 11, color, trackColor, paused }: SpinnerProps) {
  return (
    <span
      aria-hidden="true"
      className="azito-spinner"
      style={{
        display: 'inline-block',
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: '50%',
        border: `2px solid ${trackColor ?? 'var(--accent-a15)'}`,
        borderTopColor: color ?? 'var(--accent)',
        animation: 'azito-spin 0.8s linear infinite',
        animationPlayState: paused ? 'paused' : 'running',
      }}
    />
  );
}
