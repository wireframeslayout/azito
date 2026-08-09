// Claude / Codex 両ソースで共有する正規化ヘルパー（トリム制限・型ガード）。

export const TOOL_USE_INPUT_LIMIT = 2000;
export const TOOL_RESULT_TEXT_LIMIT = 4000;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function truncateText(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}
