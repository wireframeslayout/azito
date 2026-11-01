export const RETENTION_PERIODS = [30 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000, 7 * 24 * 60 * 60_000] as const;
export interface FinishedRetentionSettings { maxCount: number; retentionMs: number }
export const DEFAULT_FINISHED_RETENTION: FinishedRetentionSettings = { maxCount: 10, retentionMs: 60 * 60_000 };
const STORAGE_KEY = 'active-windows-retention';

export function loadFinishedRetention(): FinishedRetentionSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== 'object') return DEFAULT_FINISHED_RETENTION;
    const { maxCount, retentionMs } = value as Record<string, unknown>;
    return {
      maxCount: typeof maxCount === 'number' && Number.isInteger(maxCount) && maxCount >= 0 && maxCount <= 50 ? maxCount : DEFAULT_FINISHED_RETENTION.maxCount,
      retentionMs: typeof retentionMs === 'number' && RETENTION_PERIODS.some((p) => p === retentionMs) ? retentionMs : DEFAULT_FINISHED_RETENTION.retentionMs,
    };
  } catch { return DEFAULT_FINISHED_RETENTION; }
}

export function saveFinishedRetention(settings: FinishedRetentionSettings): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* best-effort */ }
}
