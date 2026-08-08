import type { AuditLogEntry } from './AuditLogRepository';
import type { AuditLogService } from './AuditLogService';

/**
 * Shared best-effort wrapper for `AuditLogService.record()` (Issue #28
 * third-party review finding — `AgentSignalService`'s rejection paths called
 * `record()` directly and unguarded: a write failure there, e.g. disk full
 * or a locked DB, propagated out of `handleSignal` and turned the intended
 * 404/403 rejection into a generic 500 — silently upgrading a caller's
 * visible failure mode from "not found"/"forbidden" to "server error"
 * purely because of an unrelated audit-log write failure).
 *
 * The same "never let an audit write failure change the caller's own
 * decision" rule was already applied ad hoc in two other places
 * (`app/buildServer.ts`'s route-auth `onRequest` hook, and
 * `SupervisorRegistry`'s private `audit()` method) before this existed as a
 * standalone function — this is the one place that decides HOW an audit
 * write failure is handled, so a caller doesn't have to reimplement the
 * try/catch itself. `onError` defaults to a no-op (fully silent) — pass a
 * logger callback when the call site has one available and wants the
 * failure visible for diagnosis (matches buildServer.ts's `request.log.error`
 * usage) without pulling a specific logger implementation into this module.
 */
export function recordAuditBestEffort(
  auditLogService: AuditLogService | undefined,
  entry: AuditLogEntry,
  onError?: (err: unknown) => void,
): void {
  try {
    auditLogService?.record(entry);
  } catch (err) {
    onError?.(err);
  }
}
