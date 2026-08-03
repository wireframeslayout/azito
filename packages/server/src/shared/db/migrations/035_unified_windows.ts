import type Database from 'better-sqlite3';

export const version = 35;
export const description = 'Unify project_windows and task_windows into a single windows table';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS windows (
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
      CHECK (
        (owner_type = 'project' AND project_id IS NOT NULL AND task_id IS NULL)
        OR (owner_type = 'task' AND task_id IS NOT NULL AND project_id IS NULL)
      )
    )
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_windows_project_unique
      ON windows (project_id, server_name, tmux_target)
      WHERE owner_type = 'project'
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_windows_task_id
      ON windows (task_id)
      WHERE owner_type = 'task'
  `);

  // Migrate data from project_windows
  const hasProjectWindows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='project_windows'"
  ).get();

  if (hasProjectWindows) {
    db.exec(`
      INSERT INTO windows (owner_type, project_id, server_name, tmux_target, label, window_type)
      SELECT 'project', project_id, server_name, tmux_target, label, 'terminal'
      FROM project_windows
    `);
  }

  // Migrate data from task_windows
  const hasTaskWindows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='task_windows'"
  ).get();

  if (hasTaskWindows) {
    db.exec(`
      INSERT INTO windows (owner_type, task_id, server_name, tmux_target, label, is_primary, window_type, created_at)
      SELECT 'task', task_id, server_name, tmux_target, label, is_primary, 'terminal', created_at
      FROM task_windows
    `);

    // Copy agent_session_id from tasks to primary windows
    db.exec(`
      UPDATE windows
      SET agent_session_id = (
        SELECT t.agent_session_id FROM tasks t WHERE t.id = windows.task_id
      )
      WHERE owner_type = 'task'
        AND is_primary = 1
        AND EXISTS (
          SELECT 1 FROM tasks t WHERE t.id = windows.task_id AND t.agent_session_id IS NOT NULL
        )
    `);
  }

  // Remove old tables
  if (hasProjectWindows) {
    db.exec('DROP TABLE project_windows');
  }
  if (hasTaskWindows) {
    db.exec('DROP TABLE task_windows');
  }
}
