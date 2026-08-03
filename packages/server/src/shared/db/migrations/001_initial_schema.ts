import type { Database } from 'better-sqlite3';

export const version = 1;
export const description = 'Initial schema: servers, projects, sidekicks, tasks, execution_log';

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS servers (
      name TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'ssh',
      host TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      working_directory TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS project_repositories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      name TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS project_windows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      server_name TEXT NOT NULL,
      tmux_target TEXT NOT NULL,
      label TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (server_name) REFERENCES servers(name) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      api_key TEXT,
      base_url TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sidekicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      server_name TEXT NOT NULL,
      tmux_session TEXT NOT NULL,
      orchestrator_provider_id TEXT,
      orchestrator_model TEXT,
      worker_command TEXT,
      worker_provider_id TEXT,
      worker_model TEXT,
      system_prompt TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (server_name) REFERENCES servers(name) ON DELETE CASCADE,
      FOREIGN KEY (orchestrator_provider_id) REFERENCES llm_providers(id) ON DELETE SET NULL,
      FOREIGN KEY (worker_provider_id) REFERENCES llm_providers(id) ON DELETE SET NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS project_sidekicks (
      project_id INTEGER NOT NULL,
      sidekick_id INTEGER NOT NULL,
      PRIMARY KEY (project_id, sidekick_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (sidekick_id) REFERENCES sidekicks(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      sidekick_id INTEGER,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      priority INTEGER DEFAULT 0,
      tmux_window TEXT,
      source TEXT NOT NULL DEFAULT 'local',
      source_ref TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (sidekick_id) REFERENCES sidekicks(id) ON DELETE SET NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      sidekick_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      content TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL,
      FOREIGN KEY (sidekick_id) REFERENCES sidekicks(id) ON DELETE CASCADE
    )
  `);
}
