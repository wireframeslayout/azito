/**
 * グループ列の中で日付が変わる境界に挿入する、中央寄せの日付チップ（Issue #69 Phase C）。
 */
export function DateDivider({ label }: { label: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        margin: 'var(--space-4) 0 var(--space-3)',
        pointerEvents: 'none',
      }}
    >
      <span
        style={{
          padding: 'var(--space-1) var(--space-3)',
          borderRadius: 'var(--radius-full)',
          background: 'var(--bg-solid)',
          color: 'var(--text-dim)',
          fontSize: 'var(--font-2xs)',
          fontWeight: 600,
          boxShadow: 'var(--shadow-1)',
        }}
      >
        {label}
      </span>
    </div>
  );
}
