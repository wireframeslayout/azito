import type { Database } from 'better-sqlite3';

export const version = 2;
export const description = 'Legacy migrations: project_servers→project_windows, sidekick column renames';

export function up(db: Database): void {
  // Migrate project_servers → project_windows
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_servers'").get() as { name: string } | undefined;
    if (tables) {
      const rows = db.prepare('SELECT * FROM project_servers').all() as Array<{ project_id: number; server_name: string }>;
      const insert = db.prepare('INSERT OR IGNORE INTO project_windows (project_id, server_name, tmux_target) VALUES (?, ?, ?)');
      for (const r of rows) {
        insert.run(r.project_id, r.server_name, '*');
      }
      db.exec('DROP TABLE project_servers');
    }
  } catch {}

  // Rename sidekick columns: provider_id → orchestrator_provider_id, model → orchestrator_model
  try {
    const cols = (db.prepare('PRAGMA table_info(sidekicks)').all() as Array<{ name: string }>).map((c) => c.name);
    if (cols.includes('provider_id') && !cols.includes('orchestrator_provider_id')) {
      db.exec('ALTER TABLE sidekicks RENAME COLUMN provider_id TO orchestrator_provider_id');
      db.exec('ALTER TABLE sidekicks RENAME COLUMN model TO orchestrator_model');
      db.exec('ALTER TABLE sidekicks ADD COLUMN worker_command TEXT');
      db.exec('ALTER TABLE sidekicks ADD COLUMN worker_provider_id TEXT');
      db.exec('ALTER TABLE sidekicks ADD COLUMN worker_model TEXT');
    }
    if (!cols.includes('worker_command') && cols.includes('orchestrator_provider_id')) {
      try { db.exec('ALTER TABLE sidekicks ADD COLUMN worker_command TEXT'); } catch {}
      try { db.exec('ALTER TABLE sidekicks ADD COLUMN worker_provider_id TEXT'); } catch {}
      try { db.exec('ALTER TABLE sidekicks ADD COLUMN worker_model TEXT'); } catch {}
    }
  } catch {}
}
