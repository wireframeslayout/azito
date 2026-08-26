import type { IServerRepository } from './Server';
import { ISOLATION_CLEANUP_PENDING_REPORT } from './Server';

/**
 * Startup-only recovery pass (Issue #29 review, final pass, Important
 * finding 2): `updateIsolationIntent` writes `ISOLATION_CLEANUP_PENDING_REPORT`
 * atomically with a false->true intent flip, BEFORE
 * `attemptIsolationCleanup` (servers/routes.ts) actually runs the remote
 * purge and overwrites it with a settled done/failed/skipped outcome. If the
 * hub process dies in that window (crash, forced restart, OOM-kill), the
 * pending marker is left behind with no request in flight to ever finish it
 * — a same-value true->true PUT retries it (see routes.ts's
 * `isolationCleanupNeedsRetry`), but nothing prompts an operator to send
 * one, so a stuck row could sit "pending" indefinitely and read as "cleanup
 * in progress" when nothing is actually running.
 *
 * This function converts any such stranded row's report to
 * `{"kind":"cleanup","cleanup":"failed","reason":"interrupted"}` at hub
 * startup — surfacing the interruption honestly (matching how a genuine
 * remote failure reads) — WITHOUT re-attempting the cleanup itself. Deliberate:
 * automatically re-running a remote SSH/harness-install side effect against
 * a server the hub has not yet reconnected to, purely because the hub
 * itself just restarted, is a different (and much riskier) decision than
 * this narrow "make stale state honest" pass is meant to make. An operator
 * (or a future doctor/reinstall flow) who wants the retry can trigger it
 * explicitly — a true->true PUT after this pass runs now correctly sees
 * `'failed'` instead of a silently-stuck `'pending'` and retries on its own.
 */
export function recoverInterruptedIsolationCleanup(serverRepo: IServerRepository): number {
  let recoveredCount = 0;
  for (const srv of serverRepo.findAll()) {
    // Review round (Important finding 4): the pending marker now lives in
    // isolation_cleanup_report (split out of isolation_report, which is
    // verification-only from here on — see Server.ts's doc comments), and
    // this recovery pass writes back to that same cleanup-only column.
    if (srv.isolationCleanupReport !== ISOLATION_CLEANUP_PENDING_REPORT) continue;
    serverRepo.updateIsolationCleanupReport?.(
      srv.name,
      JSON.stringify({ kind: 'cleanup', cleanup: 'failed', reason: 'interrupted' }),
    );
    recoveredCount++;
  }
  return recoveredCount;
}
