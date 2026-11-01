export interface DiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

const MAX_LINES = 20_000;
const MAX_CELLS = 1_000_000;
const MAX_RENDER_LINES = 5_000;

/** Computes a bounded line diff; returns null when its work budget would be exceeded. */
export function lineDiff(before: string, after: string): DiffLine[] | null {
  const left = before.split('\n');
  const right = after.split('\n');
  if (left.length > MAX_LINES || right.length > MAX_LINES || left.length * right.length > MAX_CELLS || left.length + right.length > MAX_RENDER_LINES) return null;
  const width = right.length + 1;
  const lengths = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      const index = i * width + j;
      lengths[index] = left[i] === right[j] ? 1 + lengths[(i + 1) * width + j + 1] : Math.max(lengths[(i + 1) * width + j], lengths[index + 1]);
    }
  }
  const result: DiffLine[] = [];
  let i = 0; let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { result.push({ kind: 'same', text: left[i++] }); j++; }
    else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) result.push({ kind: 'removed', text: left[i++] });
    else result.push({ kind: 'added', text: right[j++] });
  }
  while (i < left.length) result.push({ kind: 'removed', text: left[i++] });
  while (j < right.length) result.push({ kind: 'added', text: right[j++] });
  return result;
}
