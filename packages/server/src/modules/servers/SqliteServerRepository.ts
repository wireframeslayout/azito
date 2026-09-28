import type { SqliteDatabase } from '../../shared/db/Database';
import { seal, open } from '../../shared/crypto/SecretBox';
import type { ServerConfig, IServerRepository, MuxRuntime, ServerMeta } from './Server';
import { ISOLATION_CLEANUP_PENDING_REPORT } from './Server';

const COLUMNS = 'name, type, host, agent_port, agent_token, agent_version, ssh_host, mux_runtime, ssh_host_fingerprint, isolation_intent, isolation_verified_at, isolation_report, isolation_cleanup_report, created_at';

export class SqliteServerRepository implements IServerRepository {
  private listStmt;
  private getStmt;
  private addStmt;
  private removeStmt;
  private updateStmt;
  private updateAgentVersionStmt;
  private updateFingerprintStmt;
  private clearFingerprintStmt;
  private updateIsolationIntentStmt;
  private updateIsolationReportStmt;
  private updateIsolationCleanupReportStmt;
  private updateIsolationVerificationStmt;
  private updateIsolationFailureStmt;

  constructor(private db: SqliteDatabase) {
    this.listStmt = db.prepare(`SELECT ${COLUMNS} FROM servers WHERE type IN ('local', 'agent') ORDER BY created_at`);
    this.getStmt = db.prepare(`SELECT ${COLUMNS} FROM servers WHERE name = ? AND type IN ('local', 'agent')`);
    this.addStmt = db.prepare('INSERT INTO servers (name, type, host, agent_port, agent_token, agent_version, ssh_host, mux_runtime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    this.removeStmt = db.prepare('DELETE FROM servers WHERE name = ?');
    this.updateStmt = db.prepare('UPDATE servers SET type = ?, host = ?, agent_port = ?, agent_token = ?, ssh_host = ?, mux_runtime = ? WHERE name = ?');
    this.updateAgentVersionStmt = db.prepare('UPDATE servers SET agent_version = ? WHERE name = ?');
    this.updateFingerprintStmt = db.prepare('UPDATE servers SET ssh_host_fingerprint = ? WHERE name = ?');
    this.clearFingerprintStmt = db.prepare('UPDATE servers SET ssh_host_fingerprint = NULL WHERE name = ?');
    // Issue #29 review, Important finding 3: clears isolation_verified_at
    // and isolation_report (the DOCTOR's verification column) in the SAME
    // UPDATE as the intent flip — an intent switch (true<->false, or
    // auto-cleared on type -> local) must not leave a PRE-transition doctor
    // report looking like it describes the NEW state. Atomic (single
    // statement) rather than a separate clear call so no reader can observe
    // an intermediate row with a stale report next to the new intent.
    //
    // Issue #29 review (final pass), Important finding 2: the
    // isolation_cleanup_report column is now a bound parameter, not a
    // hardcoded NULL — `updateIsolationIntent` below passes
    // ISOLATION_CLEANUP_PENDING_REPORT for a false->true flip (so the
    // pending marker lands in the SAME statement as the flip, not a later
    // one `attemptIsolationCleanup` might never reach if the process crashes
    // in between) and NULL for every other direction, matching the previous
    // unconditional-clear behavior.
    //
    // Review round (Important finding 4): isolation_report
    // (verification-only, after the column split — see Server.ts's doc
    // comments) is unconditionally cleared to NULL here too, same as
    // isolation_verified_at — a stale pre-transition DOCTOR result must not
    // survive an intent flip either, independent of the cleanup column this
    // statement's own parameter targets.
    this.updateIsolationIntentStmt = db.prepare(
      'UPDATE servers SET isolation_intent = ?, isolation_verified_at = NULL, isolation_report = NULL, isolation_cleanup_report = ? WHERE name = ?',
    );
    this.updateIsolationReportStmt = db.prepare('UPDATE servers SET isolation_report = ? WHERE name = ?');
    // Review round (Important finding 4): the cleanup-only counterpart to
    // updateIsolationReportStmt above, writing to the separate
    // isolation_cleanup_report column so a doctor run (updateIsolationReport
    // / updateIsolationVerification, both verification-column-only) can
    // never clobber a settled cleanup outcome, or vice versa.
    this.updateIsolationCleanupReportStmt = db.prepare('UPDATE servers SET isolation_cleanup_report = ? WHERE name = ?');
    // Issue #29 Step 2 B: the isolation doctor's passing-run writer — sets
    // isolation_report AND isolation_verified_at atomically, so a reader
    // never observes one updated without the other (see
    // IServerRepository.updateIsolationVerification's doc comment).
    this.updateIsolationVerificationStmt = db.prepare('UPDATE servers SET isolation_report = ?, isolation_verified_at = ? WHERE name = ?');
    // Issue #29 review Step 3a, Critical finding 1: the doctor's
    // failing/unverifiable-run writer — sets isolation_report AND clears
    // isolation_verified_at to NULL atomically, so a stale PASSING
    // isolation_verified_at from an earlier run can never survive a later
    // run that failed to reconfirm it (see IServerRepository.
    // updateIsolationFailure's doc comment).
    this.updateIsolationFailureStmt = db.prepare('UPDATE servers SET isolation_report = ?, isolation_verified_at = NULL WHERE name = ?');
  }

  findAll(): ServerConfig[] {
    const rows = this.listStmt.all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.toEntity(r));
  }

  // Deliberately does NOT go through `toEntity()` (Issue #87 配信状態の可視化):
  // that mapper decrypts `agent_token`, so routing a read-only listing
  // through it would let one server's broken credential fail the whole
  // response — including for callers that never reference that server. Only
  // the three non-secret columns are selected, so `open()` is never reached.
  findMetaByNames(names: string[]): ServerMeta[] {
    if (names.length === 0) return [];
    const placeholders = names.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `SELECT name, type, isolation_intent FROM servers WHERE name IN (${placeholders}) AND type IN ('local', 'agent')`,
    ).all(...names) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      name: row.name as string,
      type: row.type as ServerConfig['type'],
      isolationIntent: (row.isolation_intent as number) === 1,
    }));
  }

  findByName(name: string): ServerConfig | null {
    const row = this.getStmt.get(name) as Record<string, unknown> | undefined;
    return row ? this.toEntity(row) : null;
  }

  create(name: string, type: string, host?: string, agentPort?: number, agentToken?: string, agentVersion?: string, sshHost?: string, muxRuntime?: MuxRuntime): void {
    this.addStmt.run(name, type, host ?? null, agentPort ?? null, seal(agentToken ?? null), agentVersion ?? null, sshHost ?? null, muxRuntime ?? 'system');
  }

  update(name: string, type: string, host?: string, agentPort?: number, agentToken?: string, sshHost?: string, muxRuntime?: MuxRuntime): void {
    this.updateStmt.run(type, host ?? null, agentPort ?? null, seal(agentToken ?? null), sshHost ?? null, muxRuntime ?? 'system', name);
  }

  // Issue #29 review, Important finding 1: routes.ts's "type no longer
  // agent -> auto-clear isolation_intent" path used to run this same
  // connection-info UPDATE and the isolation-intent clear as two separate
  // SQLite statements. A crash (or any error) between the two left the row
  // with the NEW type but the OLD isolation_intent=1 still set — exactly the
  // "isolated non-agent server" state the auto-clear exists to make
  // unreachable. Wrapped in `db.transaction()` (matches the pattern used by
  // SqliteTaskRepository.update / consumePendingApproval) so both writes
  // commit or neither does.
  updateWithIsolationClear(name: string, type: string, host?: string, agentPort?: number, agentToken?: string, sshHost?: string, muxRuntime?: MuxRuntime): void {
    const run = this.db.transaction(() => {
      this.update(name, type, host, agentPort, agentToken, sshHost, muxRuntime);
      this.updateIsolationIntentStmt.run(0, null, name);
    });
    run();
  }

  updateAgentVersion(name: string, version: string): void {
    this.updateAgentVersionStmt.run(version, name);
  }

  updateFingerprint(name: string, fingerprint: string): void {
    this.updateFingerprintStmt.run(fingerprint, name);
  }

  clearFingerprint(name: string): void {
    this.clearFingerprintStmt.run(name);
  }

  updateIsolationIntent(name: string, isolationIntent: boolean): void {
    // See the constructor comment above and IServerRepository's doc comment:
    // only the false->true direction gets the pending marker (there is a
    // cleanup attempt to track); every other direction clears to NULL as
    // before. This does not distinguish "was already true" from "was
    // false" — a redundant true->true call here (routes.ts's own no-op
    // guard normally prevents that) would also reset an existing done/
    // failed report back to pending, which is why routes.ts never calls
    // this method for a true->true transition; it calls
    // `attemptIsolationCleanup`/`updateIsolationReport` directly instead.
    const report = isolationIntent ? ISOLATION_CLEANUP_PENDING_REPORT : null;
    this.updateIsolationIntentStmt.run(isolationIntent ? 1 : 0, report, name);
  }

  updateIsolationReport(name: string, report: string | null): void {
    this.updateIsolationReportStmt.run(report, name);
  }

  updateIsolationCleanupReport(name: string, report: string | null): void {
    this.updateIsolationCleanupReportStmt.run(report, name);
  }

  updateIsolationVerification(name: string, report: string, verifiedAt: string): void {
    this.updateIsolationVerificationStmt.run(report, verifiedAt, name);
  }

  updateIsolationFailure(name: string, report: string): void {
    this.updateIsolationFailureStmt.run(report, name);
  }

  delete(name: string): void {
    this.removeStmt.run(name);
  }

  private toEntity(row: Record<string, unknown>): ServerConfig {
    return {
      name: row.name as string,
      type: row.type as ServerConfig['type'],
      host: (row.host as string) ?? null,
      agentPort: (row.agent_port as number) ?? null,
      agentToken: open(row.agent_token as string | null),
      agentVersion: (row.agent_version as string) ?? null,
      sshHost: (row.ssh_host as string) ?? null,
      muxRuntime: (row.mux_runtime as MuxRuntime) ?? 'system',
      sshHostFingerprint: (row.ssh_host_fingerprint as string) ?? null,
      isolationIntent: (row.isolation_intent as number) === 1,
      isolationVerifiedAt: (row.isolation_verified_at as string) ?? null,
      isolationReport: (row.isolation_report as string) ?? null,
      isolationCleanupReport: (row.isolation_cleanup_report as string) ?? null,
      createdAt: row.created_at as string,
    };
  }
}
