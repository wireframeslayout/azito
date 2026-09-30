import type Database from 'better-sqlite3';

/**
 * Pre-068 production DDL for the `windows` table — server001 backup at migration 067.
 * Includes `lifecycle TEXT NOT NULL DEFAULT 'active'` between `created_at` and `sleeping`.
 */
export const PROD_WINDOWS_DDL_PRE_068 = `
CREATE TABLE windows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_type TEXT NOT NULL CHECK (owner_type IN ('project', 'task')),
      project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      server_name TEXT NOT NULL,
      tmux_target TEXT NOT NULL,
      label TEXT,
      is_primary INTEGER NOT NULL DEFAULT 0,
      window_type TEXT NOT NULL DEFAULT 'terminal' CHECK (window_type IN ('terminal', 'agent')),
      worker_type TEXT,
      worker_model TEXT,
      agent_session_id TEXT,
      launch_command TEXT,
      working_directory TEXT,
      pane_layout TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      lifecycle TEXT NOT NULL DEFAULT 'active',
      sleeping INTEGER NOT NULL DEFAULT 0,
      CHECK (
        (owner_type = 'project' AND project_id IS NOT NULL AND task_id IS NULL)
        OR (owner_type = 'task' AND task_id IS NOT NULL AND project_id IS NULL)
      )
    )`;

/**
 * Replace the `windows` table in `db` with the pre-068 production schema.
 * The caller should have run migrations up to (but NOT including) 068.
 * Existing rows are preserved via a temp table round-trip.
 */
export function applyProductionWindowsDrift(db: Database.Database): void {
  db.exec('ALTER TABLE windows RENAME TO _windows_backup');
  db.exec(PROD_WINDOWS_DDL_PRE_068);
  // Copy existing rows — column set from the new-chain schema (no lifecycle/sleeping yet at this point)
  const cols = db.pragma('table_info(_windows_backup)') as { name: string }[];
  const colNames = cols.map(c => c.name);
  const colList = colNames.map(c => `"${c}"`).join(', ');
  db.exec(`INSERT INTO windows (${colList}) SELECT ${colList} FROM _windows_backup`);
  db.exec('DROP TABLE _windows_backup');
}
