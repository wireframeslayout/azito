export function ActiveWindowDot() {
  return (
    <span
      aria-hidden="true"
      style={{
        position: 'absolute',
        top: 1,
        right: 1,
        width: 10,
        height: 10,
        borderRadius: '50%',
        background: 'var(--success)',
        border: '1.5px solid var(--bg)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <svg viewBox="0 0 8 6" width={5} height={4} aria-hidden="true">
        <path
          d="M1 3l2 2 4-4"
          stroke="#fff" // lint-allow: hex - white checkmark on solid var(--success) dot; no on-color token yet
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
