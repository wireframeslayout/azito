import type { AuditLogEntry, IAuditLogRepository } from './AuditLogRepository';

/**
 * Collapses repeats of the same actor+event within a short window before
 * they reach the DB (design v3 §10: "同種イベントの単純な洪水対策...を最低限
 * 入れる") — e.g. a misconfigured client hammering an operator-only route
 * with a task token would otherwise write one row per request.
 *
 * This is an in-memory, single-process rate limit: it resets on restart and
 * does not coordinate across hub instances. That's acceptable for its
 * purpose (protecting audit_log from flooding), not for anything requiring
 * a hard guarantee.
 */
const FLOOD_WINDOW_MS = 30_000;

export class AuditLogService {
  private lastLoggedAt = new Map<string, number>();

  constructor(
    private repo: IAuditLogRepository,
    private now: () => number = Date.now,
  ) {}

  record(entry: AuditLogEntry): void {
    const key = `${entry.actorClass}:${entry.actorId ?? ''}:${entry.event}`;
    const nowMs = this.now();
    const last = this.lastLoggedAt.get(key);
    if (last !== undefined && nowMs - last < FLOOD_WINDOW_MS) return;
    this.lastLoggedAt.set(key, nowMs);
    this.repo.record(entry);
  }
}
