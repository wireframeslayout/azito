/** サイズをKB/MB表記に変換する（1000区切りではなく1024区切り）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

/** 実パス（例: cwd）の末尾セグメントを取り出す。 */
export function pathBasename(fullPath: string): string {
  const segments = fullPath.split('/').filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : fullPath;
}

/** タイムスタンプを表示用に整形する。同日ならHH:mm、それ以外は日付付き。不正な値は空文字。 */
export function formatEntryTimestamp(timestamp: string | null, language: string): string {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  if (!Number.isFinite(d.getTime())) return '';

  const now = new Date();
  const isSameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();

  if (isSameDay) {
    return new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' }).format(d);
  }
  return new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
}
