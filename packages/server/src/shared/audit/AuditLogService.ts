import type { AuditLogEntry, IAuditLogRepository } from './AuditLogRepository';

/**
 * Collapses repeats of the exact same actor+event+detail within a short
 * window before they reach the DB (design v3 §10: "同種イベントの単純な洪水
 * 対策...を最低限入れる") — e.g. a misconfigured client hammering an
 * operator-only route with a task token would otherwise write one row per
 * request.
 *
 * The dedup key includes `detail` (JSON-serialized) precisely so this only
 * ever suppresses a truly identical event repeated in quick succession — a
 * token issued for a different task, a denial for a different operation,
 * etc. each carry different `detail` and therefore always get their own row
 * (Issue #28 third-party review finding: actor+event alone conflated
 * distinct security events, e.g. "token issued for task 5" and "token
 * issued for task 9", into a single suppressed line).
 *
 * This is an in-memory, single-process rate limit: it resets on restart and
 * does not coordinate across hub instances. That's acceptable for its
 * purpose (protecting audit_log from flooding), not for anything requiring
 * a hard guarantee.
 */
const FLOOD_WINDOW_MS = 30_000;

/**
 * Upper bound on how many distinct dedup keys are tracked at once. Without
 * this, a long-running process that sees an ever-growing set of distinct
 * actor/event/detail combinations (e.g. one key per taskId) would grow
 * `lastLoggedAt` forever (Issue #28 third-party review finding 5). Expired
 * entries are swept lazily on each record() call; if the map is still over
 * the cap after sweeping, the oldest entries are evicted (insertion order —
 * Map iterates oldest-first).
 */
const MAX_TRACKED_KEYS = 10_000;

export class AuditLogService {
  private lastLoggedAt = new Map<string, number>();

  constructor(
    private repo: IAuditLogRepository,
    private now: () => number = Date.now,
  ) {}

  /**
   * Marks the dedup key AFTER `repo.record()` succeeds, not before (Issue #28
   * third-party review finding 4): if the write throws (DB busy, disk full,
   * etc.), the key must NOT be marked as "just logged" — otherwise a retried
   * call for the very same event within FLOOD_WINDOW_MS would be silently
   * suppressed by the dedup check above, and the audit event would simply
   * never reach the DB. Marking on success only means a burst of write
   * failures can each be retried and (once the write succeeds) recorded.
   */
  record(entry: AuditLogEntry): void {
    const key = `${entry.actorClass}:${entry.actorId ?? ''}:${entry.event}:${JSON.stringify(entry.detail ?? {})}`;
    const nowMs = this.now();
    this.sweepExpired(nowMs);
    const last = this.lastLoggedAt.get(key);
    if (last !== undefined && nowMs - last < FLOOD_WINDOW_MS) return;
    this.repo.record(entry);
    this.lastLoggedAt.set(key, nowMs);
    this.evictOldestIfOverCap();
  }

  private sweepExpired(nowMs: number): void {
    for (const [key, loggedAt] of this.lastLoggedAt) {
      if (nowMs - loggedAt >= FLOOD_WINDOW_MS) this.lastLoggedAt.delete(key);
    }
  }

  private evictOldestIfOverCap(): void {
    while (this.lastLoggedAt.size > MAX_TRACKED_KEYS) {
      const oldestKey = this.lastLoggedAt.keys().next().value;
      if (oldestKey === undefined) break;
      this.lastLoggedAt.delete(oldestKey);
    }
  }
}
