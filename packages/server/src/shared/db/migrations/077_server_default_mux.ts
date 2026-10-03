import type Database from 'better-sqlite3';

export const version = 77;
export const description = 'Split servers.mux_runtime into default_mux (tmux/misao) and mux_runtime (tmux binary: system/managed)';

export function up(db: Database.Database): void {
  const cols = db.prepare('PRAGMA table_info(servers)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'default_mux')) {
    db.exec(`ALTER TABLE servers ADD COLUMN default_mux TEXT NOT NULL DEFAULT 'tmux'`);
  }
  db.exec(`UPDATE servers SET default_mux = 'misao', mux_runtime = 'system' WHERE mux_runtime = 'misao'`);
}
