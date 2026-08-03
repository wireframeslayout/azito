import type Database from 'better-sqlite3';

export const version = 36;
export const description = 'Remove project_sidekicks assignment and unused sidekick columns (worker_provider_id, orchestrator_provider_id, orchestrator_model, max_concurrency, status)';

/**
 * Two of the columns being removed (worker_provider_id, orchestrator_provider_id) carry an
 * inline FOREIGN KEY constraint, so `ALTER TABLE ... DROP COLUMN` is rejected by SQLite
 * ("unknown column ... in foreign key definition"). The table must be rebuilt instead.
 *
 * Rebuilding a table that other tables reference via FOREIGN KEY (tasks.sidekick_id,
 * execution_log.sidekick_id) is dangerous with default SQLite semantics: renaming the
 * table auto-rewrites the referencing tables' FK clauses to the new (temporary) name, and
 * dropping that temporary table afterwards either cascades the configured ON DELETE action
 * across all existing rows or leaves a dangling reference that breaks all future writes to
 * the referencing tables. To rebuild safely without touching tasks/execution_log at all, the
 * migration runner temporarily disables `foreign_keys` and enables `legacy_alter_table`
 * around this migration's transaction (see Database.ts) so that renames keep the referencing
 * tables' FK text pointed at the literal name "sidekicks" throughout the rebuild.
 */
export function up(db: Database.Database): void {
  db.exec('DROP TABLE IF EXISTS project_sidekicks');

  db.exec('ALTER TABLE sidekicks RENAME TO sidekicks_old_036');

  db.exec(`
    CREATE TABLE sidekicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      server_name TEXT NOT NULL,
      tmux_session TEXT NOT NULL,
      worker_type TEXT,
      worker_extra_args TEXT,
      worker_model TEXT,
      orchestrator_mode TEXT NOT NULL DEFAULT 'state-machine',
      system_prompt TEXT,
      self_review_max_attempts INTEGER NOT NULL DEFAULT 2,
      review_subagent TEXT,
      implement_subagent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (server_name) REFERENCES servers(name) ON DELETE CASCADE
    )
  `);

  db.exec(`
    INSERT INTO sidekicks (
      id, name, server_name, tmux_session, worker_type, worker_extra_args, worker_model,
      orchestrator_mode, system_prompt, self_review_max_attempts, review_subagent,
      implement_subagent, created_at, updated_at
    )
    SELECT
      id, name, server_name, tmux_session, worker_type, worker_extra_args, worker_model,
      orchestrator_mode, system_prompt, self_review_max_attempts, review_subagent,
      implement_subagent, created_at, updated_at
    FROM sidekicks_old_036
  `);

  db.exec('DROP TABLE sidekicks_old_036');
}
