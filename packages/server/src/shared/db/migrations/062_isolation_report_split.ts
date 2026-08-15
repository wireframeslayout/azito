import type Database from 'better-sqlite3';

export const version = 62;
export const description = 'servers.isolation_cleanup_report — split cleanup outcome from doctor verification report (Issue #29 isolation doctor review, Important finding 4)';

/**
 * Before this migration, `isolation_report` was shared by two independent
 * writers: PUT /api/servers/:name's false->true `attemptIsolationCleanup`
 * (`{"kind":"cleanup",...}`) and POST .../isolation/doctor's
 * `runIsolationDoctor` (`{"kind":"verification",...}`) — whichever ran LAST
 * won the column, so running the doctor after a cleanup (or vice versa)
 * silently overwrote the other's outcome. `isolationCleanupNeedsRetry`
 * (routes.ts) then read that same column expecting a settled cleanup
 * outcome, so a doctor run made a completed cleanup look "not done" again
 * and could re-trigger a cleanup retry the operator never asked for. The UI
 * (OverviewSection) could show only whichever kind happened to be sitting in
 * the column, never both notices at once.
 *
 * This migration adds a dedicated `isolation_cleanup_report` column and
 * moves any EXISTING `isolation_report` value that is a `kind: 'cleanup'`
 * report (including the `ISOLATION_CLEANUP_PENDING_REPORT` pending marker,
 * which also carries `kind: 'cleanup'`) into it, clearing the old column for
 * those rows. A `kind: 'verification'` (or any other/unparseable) value is
 * left in `isolation_report` untouched — that column's remaining, sole
 * purpose from here on. `isolation_report` going forward is verification-only;
 * `isolation_cleanup_report` is cleanup-only. See Server.ts's
 * `isolationReport`/`isolationCleanupReport` doc comments for the writers
 * each column now has (routes.ts's `attemptIsolationCleanup` /
 * `updateIsolationIntent`'s pending-marker write / `runIsolationDoctor`'s
 * persistence, and `SqliteServerRepository`'s corresponding statements).
 */
export function up(db: Database.Database): void {
  db.exec('ALTER TABLE servers ADD COLUMN isolation_cleanup_report TEXT');

  const rows = db.prepare('SELECT name, isolation_report FROM servers WHERE isolation_report IS NOT NULL').all() as Array<{ name: string; isolation_report: string }>;
  if (rows.length === 0) return;

  const moveToCleanup = db.prepare('UPDATE servers SET isolation_cleanup_report = ?, isolation_report = NULL WHERE name = ?');
  const migrate = db.transaction(() => {
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.isolation_report);
      } catch {
        continue; // Unparseable — leave untouched rather than guess which column it belongs in.
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as { kind?: unknown }).kind === 'cleanup') {
        moveToCleanup.run(row.isolation_report, row.name);
      }
    }
  });
  migrate();
}
