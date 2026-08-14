/**
 * グループ列の中で日付が変わる境界に挿入する、中央寄せの日付チップ（Issue #69 Phase C）。
 * position: sticky で、スクロール中は現在表示中の日付が上端に留まる。
 */
export function DateDivider({ label }: { label: string }) {
  return (
    <div
      style={{
        position: 'sticky',
        top: 6,
        zIndex: 1,
        display: 'flex',
        justifyContent: 'center',
        margin: '14px 0 10px',
        pointerEvents: 'none',
      }}
    >
      <span
        style={{
          padding: '4px 12px',
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
