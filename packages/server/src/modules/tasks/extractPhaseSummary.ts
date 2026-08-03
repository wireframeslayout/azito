const MARKER = 'AZITO_PHASE_SUMMARY:';

export function extractPhaseSummary(output: string): { cleanOutput: string; summary: Record<string, unknown> | null } {
  const idx = output.lastIndexOf(MARKER);
  if (idx < 0) return { cleanOutput: output, summary: null };
  const afterMarker = output.slice(idx + MARKER.length);
  const jsonStr = afterMarker.split('\n').find(l => l.trim())?.trim() ?? '';
  const cleanOutput = output.slice(0, idx).trimEnd();
  if (!jsonStr) return { cleanOutput, summary: null };
  try {
    const parsed: unknown = JSON.parse(jsonStr);
    if (typeof parsed === 'object' && parsed !== null) {
      return { cleanOutput, summary: parsed as Record<string, unknown> };
    }
    return { cleanOutput, summary: null };
  } catch {
    return { cleanOutput, summary: null };
  }
}
