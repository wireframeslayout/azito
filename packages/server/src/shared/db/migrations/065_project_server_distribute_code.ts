import type Database from 'better-sqlite3';

export const version = 65;
export const description = 'project_servers.distribute_code — per-project opt-in for hub-代行 code distribution to a non-isolated agent/ssh server (Issue #87 Phase 2), defaults off';

export function up(db: Database.Database): void {
  db.exec(`ALTER TABLE project_servers ADD COLUMN distribute_code INTEGER NOT NULL DEFAULT 0`);
}
