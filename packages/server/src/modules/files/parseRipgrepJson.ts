export interface RipgrepMatch {
  path: string;
  line: number;
  column: number;
  text: string;
  matchStart: number;
  matchEnd: number;
}

export function parseRipgrepJson(output: string): RipgrepMatch[] {
  const results: RipgrepMatch[] = [];
  if (!output.trim()) return results;

  for (const raw of output.split('\n')) {
    if (!raw.trim()) continue;
    let parsed: { type?: string; data?: Record<string, unknown> };
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (parsed.type !== 'match' || !parsed.data) continue;

    const data = parsed.data;
    const pathObj = data.path as { text?: string } | undefined;
    const filePath = pathObj?.text;
    if (!filePath) continue;

    const lineNumber = data.line_number as number | undefined;
    const linesObj = data.lines as { text?: string } | undefined;
    const text = linesObj?.text?.replace(/\n$/, '') ?? '';

    const submatches = data.submatches as Array<{ start?: number; end?: number }> | undefined;
    const firstMatch = submatches?.[0];
    const matchStart = firstMatch?.start ?? 0;
    const matchEnd = firstMatch?.end ?? 0;

    results.push({
      path: filePath,
      line: lineNumber ?? 0,
      column: matchStart + 1,
      text,
      matchStart,
      matchEnd,
    });
  }

  return results;
}
