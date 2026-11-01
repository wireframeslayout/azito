import type { ActiveWindowRow } from '../hooks/useActiveWindowRows';

function rank(row: ActiveWindowRow): number {
  if (row.status === 'running') return row.activityStatus === 'blocked' ? 0 : 1;
  return row.seenAt == null ? 2 : 3;
}

export function sortActiveWindowRows(rows: ActiveWindowRow[]): ActiveWindowRow[] {
  return [...rows].sort((a, b) => rank(a) - rank(b) || (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
}
