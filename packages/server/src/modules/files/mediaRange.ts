export type MediaRange = { kind: 'full' } | { kind: 'invalid' } | { kind: 'partial'; start: number; end: number };

/** Multiple ranges are deliberately ignored; unsatisfiable single ranges return 416. */
export function parseMediaRange(header: string | undefined, size: number): MediaRange {
  if (!header || header.includes(',')) return { kind: 'full' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return { kind: 'full' };
  if (!size) return { kind: 'invalid' };
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (suffix <= 0) return { kind: 'invalid' };
    return { kind: 'partial', start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || start >= size || end < start) return { kind: 'invalid' };
  return { kind: 'partial', start, end: Math.min(end, size - 1) };
}
