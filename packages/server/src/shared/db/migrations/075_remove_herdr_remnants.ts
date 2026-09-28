import type Database from 'better-sqlite3';

export const version = 75;
export const description = 'Remove herdr_navigation_lock columns, normalize stale herdr/zellij data';

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

export function up(db: Database.Database): void {
  if (hasColumn(db, 'servers', 'herdr_navigation_lock')) {
    db.exec('ALTER TABLE servers DROP COLUMN herdr_navigation_lock');
  }
  if (hasColumn(db, 'windows', 'herdr_navigation_lock')) {
    db.exec('ALTER TABLE windows DROP COLUMN herdr_navigation_lock');
  }

  const runtimeResult = db.prepare(
    `UPDATE servers SET mux_runtime = 'system' WHERE mux_runtime IN ('herdr', 'zellij')`,
  ).run();
  if (runtimeResult.changes > 0) {
    console.log(`Migration 075: normalized ${runtimeResult.changes} server(s) from herdr/zellij to system`);
  }

  const staleWindows = db.prepare(`
    SELECT id FROM windows
    WHERE mux_ref IS NOT NULL
      AND json_valid(mux_ref)
      AND json_extract(mux_ref, '$.kind') != 'tmux'
  `).all() as Array<{ id: number }>;

  if (staleWindows.length > 0) {
    console.log(`Migration 075: removing ${staleWindows.length} stale non-tmux window(s)`);

    const ids = staleWindows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');

    db.prepare(`UPDATE tasks SET pending_operation_window_id = NULL WHERE pending_operation_window_id IN (${placeholders})`).run(...ids);
    db.prepare(`UPDATE agent_watches SET window_id = NULL WHERE window_id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM windows WHERE id IN (${placeholders})`).run(...ids);
  }
}
