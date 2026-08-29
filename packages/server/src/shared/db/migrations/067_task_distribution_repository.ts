import type Database from 'better-sqlite3';

export const version = 67;
export const description = 'tasks.distribution_repository_id — persists which project_repositories row fetch distribution actually pulled a task\'s code from (Issue #87 review follow-up, Important finding 1), so resume never re-resolves the distribution target from the project/project-server\'s THEN-current configuration';

/**
 * Same rename-old/create-new/copy/drop-old pattern as
 * 066_project_server_distribution_repository.ts (and 046/037's table
 * rebuilds before it): SQLite's ALTER TABLE ADD COLUMN cannot reliably add
 * an enforced FOREIGN KEY constraint, so a column that needs one requires a
 * full table rebuild instead.
 *
 * Unlike 066 (which rebuilds `project_servers`, a table nothing else
 * references via FOREIGN KEY), `tasks` IS referenced by other tables
 * (`task_tokens`, `windows`, `execution_log`, `agent_turns`, ...) — this
 * migration's version (67) is therefore added to
 * `MIGRATIONS_REQUIRING_TABLE_REBUILD` in Database.ts so the runner
 * disables `foreign_keys` / enables `legacy_alter_table` for the duration
 * of the rebuild (see that set's own doc comment for why: otherwise SQLite
 * either rewrites the referencing tables' FK clauses to the temporary
 * `tasks_old_067` name, or fires every configured ON DELETE action against
 * every row the instant the original table is renamed away).
 *
 * `ON DELETE SET NULL` (not CASCADE, and not RESTRICT): deleting a
 * `project_repositories` row must only clear the pointer to it, never touch
 * the task itself — the task and its worktree/branch/etc. remain valid and
 * inspectable; only the "which repository did this code come from" fact
 * becomes unknown. `ExecuteTaskUseCase.resumeStateMachine()` treats a
 * non-null-but-unresolvable `distributionRepositoryId` as fail-closed (see
 * `Task.distributionRepositoryId`'s own doc comment) — exactly the same
 * "repository is gone, refuse to guess" handling `resolveExecutionRepositoryEntry`
 * already applies to `project_servers.distribution_repository_id`, applied
 * here to the per-task recorded value instead of the live per-project-server
 * config.
 *
 * Existing tasks are backfilled to NULL (not derived from
 * `project_servers.distribution_repository_id`): a task that ran before this
 * column existed has no record of which repository its ALREADY-DISTRIBUTED
 * working directory actually came from, and the current
 * `project_servers.distribution_repository_id` may have changed since —
 * inferring one now would reintroduce exactly the bug this migration exists
 * to fix. `resumeStateMachine()`'s "no recorded value" branch falls back to
 * resolving from the current project/project-server config, matching this
 * column's pre-existing (bug-carrying) behavior for these rows — unchanged
 * for a task whose execution never required distribution in the first
 * place, and no worse than before this fix for one that did.
 */
export function up(db: Database.Database): void {
  db.exec('ALTER TABLE tasks RENAME TO tasks_old_067');

  db.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      unit_id INTEGER,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      priority INTEGER DEFAULT 0,
      tmux_window TEXT,
      source TEXT NOT NULL DEFAULT 'local',
      source_ref TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      self_review_count INTEGER NOT NULL DEFAULT 0,
      self_review_max_attempts INTEGER DEFAULT NULL,
      require_plan_approval INTEGER NOT NULL DEFAULT 1,
      branch TEXT,
      changed_files TEXT,
      pr_url TEXT,
      worktree_path TEXT,
      worktree_branch TEXT,
      base_branch TEXT,
      plan_markdown TEXT,
      pending_questions TEXT DEFAULT NULL,
      review_subagent TEXT,
      implement_subagent TEXT,
      target_branch TEXT,
      summary_json TEXT,
      agent_session_id TEXT,
      skip_pr INTEGER NOT NULL DEFAULT 0,
      working_directory TEXT,
      server_name TEXT REFERENCES servers(name) ON DELETE SET NULL,
      current_phase TEXT,
      input_trust TEXT NOT NULL DEFAULT 'trusted',
      execution_approved_fingerprint_hash TEXT,
      pending_operation TEXT,
      pending_operation_window_id INTEGER,
      pending_operation_prior_status TEXT,
      created_by_kind TEXT NOT NULL DEFAULT 'operator',
      created_by_id INTEGER,
      created_via_generation INTEGER,
      sleep_after_push INTEGER,
      distribution_repository_id INTEGER,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE SET NULL,
      FOREIGN KEY (distribution_repository_id) REFERENCES project_repositories(id) ON DELETE SET NULL
    )
  `);

  db.exec(`
    INSERT INTO tasks (
      id, project_id, unit_id, title, description, status, priority, tmux_window,
      source, source_ref, created_at, updated_at, self_review_count,
      self_review_max_attempts, require_plan_approval, branch, changed_files, pr_url,
      worktree_path, worktree_branch, base_branch, plan_markdown, pending_questions,
      review_subagent, implement_subagent, target_branch, summary_json, agent_session_id,
      skip_pr, working_directory, server_name, current_phase, input_trust,
      execution_approved_fingerprint_hash, pending_operation, pending_operation_window_id,
      pending_operation_prior_status, created_by_kind, created_by_id, created_via_generation,
      sleep_after_push
    )
    SELECT
      id, project_id, unit_id, title, description, status, priority, tmux_window,
      source, source_ref, created_at, updated_at, self_review_count,
      self_review_max_attempts, require_plan_approval, branch, changed_files, pr_url,
      worktree_path, worktree_branch, base_branch, plan_markdown, pending_questions,
      review_subagent, implement_subagent, target_branch, summary_json, agent_session_id,
      skip_pr, working_directory, server_name, current_phase, input_trust,
      execution_approved_fingerprint_hash, pending_operation, pending_operation_window_id,
      pending_operation_prior_status, created_by_kind, created_by_id, created_via_generation,
      sleep_after_push
    FROM tasks_old_067
  `);

  db.exec('DROP TABLE tasks_old_067');

  // Recreate the index dropped along with the old table (060_authz_foundation.ts).
  db.exec('CREATE INDEX idx_tasks_created_by ON tasks(created_by_kind, created_by_id, created_via_generation)');
}
