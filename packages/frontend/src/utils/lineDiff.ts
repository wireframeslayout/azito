export interface DiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

const MAX_LINES = 20_000;
const MAX_CELLS = 1_000_000;

/**
 * Computes a bounded line diff; returns null when its work budget would be exceeded.
 * The unchanged head and tail are matched directly, so the quadratic budget applies only to the changed middle.
 */
export function lineDiff(before: string, after: string): DiffLine[] | null {
  const left = before.split('\n');
  const right = after.split('\n');
  if (left.length > MAX_LINES || right.length > MAX_LINES) return null;
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  let leftEnd = left.length;
  let rightEnd = right.length;
  while (leftEnd > start && rightEnd > start && left[leftEnd - 1] === right[rightEnd - 1]) { leftEnd--; rightEnd--; }
  const rows = leftEnd - start;
  const cols = rightEnd - start;
  if (rows * cols > MAX_CELLS) return null;
  const width = cols + 1;
  const lengths = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      const index = i * width + j;
      lengths[index] = left[start + i] === right[start + j] ? 1 + lengths[(i + 1) * width + j + 1] : Math.max(lengths[(i + 1) * width + j], lengths[index + 1]);
    }
  }
  const result: DiffLine[] = left.slice(0, start).map((text) => ({ kind: 'same', text }));
  let i = 0; let j = 0;
  while (i < rows && j < cols) {
    if (left[start + i] === right[start + j]) { result.push({ kind: 'same', text: left[start + i] }); i++; j++; }
    else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) result.push({ kind: 'removed', text: left[start + i++] });
    else result.push({ kind: 'added', text: right[start + j++] });
  }
  while (i < rows) result.push({ kind: 'removed', text: left[start + i++] });
  while (j < cols) result.push({ kind: 'added', text: right[start + j++] });
  for (let k = leftEnd; k < left.length; k++) result.push({ kind: 'same', text: left[k] });
  return result;
}
