import { formatWindowId } from '@azito/shared';

interface WindowIdChipProps {
  id: number;
}

export function WindowIdChip({ id }: WindowIdChipProps) {
  return (
    <span title="Window ID" style={{
      fontFamily: 'var(--font-mono)', fontSize: 'var(--font-2xs)', color: 'var(--text-dim)', background: 'var(--bg-2, var(--bg))',
      borderRadius: 'var(--radius-sm)', padding: '1px 5px', flexShrink: 0, fontVariantNumeric: 'tabular-nums',
    }}>{formatWindowId(id)}</span>
  );
}
