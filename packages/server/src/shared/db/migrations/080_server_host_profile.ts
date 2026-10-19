import type Database from 'better-sqlite3';

export const version = 80;
export const description = 'Record the OS / architecture of a server host (servers.host_platform / host_arch; NULL = not recorded, i.e. a Unix agent from before Windows support)';

/** Existing rows stay NULL: nothing here claims a host is Linux. An agent's value is recorded when it is installed, updated or next reached. */
export function up(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(servers)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'host_platform')) {
    db.exec('ALTER TABLE servers ADD COLUMN host_platform TEXT');
  }
  if (!cols.some((c) => c.name === 'host_arch')) {
    db.exec('ALTER TABLE servers ADD COLUMN host_arch TEXT');
  }
}
