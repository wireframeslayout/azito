import type Database from 'better-sqlite3';
import { formatMuxRef, muxRefFromTmuxTarget } from '@azito/shared';

export const version = 69;
export const description = 'Add mux_ref column to windows';

export function up(db: Database.Database): void {
  db.exec('ALTER TABLE windows ADD COLUMN mux_ref TEXT');

  const rows = db.prepare('SELECT id, tmux_target FROM windows').all() as Array<{ id: number; tmux_target: string }>;
  const update = db.prepare('UPDATE windows SET mux_ref = ? WHERE id = ?');
  for (const row of rows) {
    const muxRef = formatMuxRef(muxRefFromTmuxTarget(row.tmux_target));
    update.run(muxRef, row.id);
  }

  db.exec('CREATE UNIQUE INDEX idx_windows_mux_ref_unique ON windows (server_name, mux_ref)');
}
