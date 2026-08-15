import type Database from 'better-sqlite3';

export const version = 61;
export const description = 'servers.isolation_intent/isolation_verified_at/isolation_report — declared isolation profile (Issue #29 Step 0/1)';

export function up(db: Database.Database): void {
  // Declared intent, not a verified fact (design v2 §"3層構成"): a server
  // operator marks a server as "meant to hold no credentials" here. This
  // column alone is what the credential-distribution blockers added in this
  // same phase (TaskPaneEnvironmentService.buildEnvForNewWindow,
  // HarnessInstaller) key off of — fail closed on intent, not on a doctor
  // check having run. `isolation_verified_at`/`isolation_report` belong to
  // the verification layer (isolation doctor, a later task) and are written
  // by nothing yet in this phase; they exist now so the doctor task doesn't
  // need its own migration.
  //
  // Default 0 (not isolated) preserves current behavior for every existing
  // row — this migration changes no runtime decision by itself, only the
  // presence of the column (Step 1's HarnessInstaller/
  // TaskPaneEnvironmentService changes are what act on it).
  db.exec('ALTER TABLE servers ADD COLUMN isolation_intent INTEGER NOT NULL DEFAULT 0');

  // Set by the (future) isolation doctor after a live check of the server
  // (e.g. "no AZITO_SECRET_* present in its environment, no other stored
  // credentials reachable"). NULL until a check has ever run.
  db.exec('ALTER TABLE servers ADD COLUMN isolation_verified_at TEXT');

  // JSON blob holding the doctor's last check result (what it looked for,
  // what it found). Not surfaced by the servers-list API (only
  // isolation_intent/isolation_verified_at are — see Server.ts's doc
  // comment); only the single-server detail route needs the full report.
  db.exec('ALTER TABLE servers ADD COLUMN isolation_report TEXT');
}
