import type Database from 'better-sqlite3';

export const version = 46;
export const description = 'Remove orchestrator_mode from units and tasks';

export function up(db: Database.Database): void {
  db.exec('ALTER TABLE units RENAME TO units_old_046');

  db.exec(`
    CREATE TABLE units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      system_prompt TEXT,
      self_review_max_attempts INTEGER NOT NULL DEFAULT 2,
      review_subagent TEXT,
      implement_subagent TEXT,
      phase_config TEXT,
      worker_type TEXT,
      worker_model TEXT,
      worker_extra_args TEXT,
      worker_execution_mode TEXT NOT NULL DEFAULT 'tmux-pipe',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    INSERT INTO units (
      id, name, system_prompt, self_review_max_attempts, review_subagent, implement_subagent,
      phase_config, worker_type, worker_model, worker_extra_args, worker_execution_mode,
      created_at, updated_at
    )
    SELECT
      id, name, system_prompt, self_review_max_attempts, review_subagent, implement_subagent,
      phase_config, worker_type, worker_model, worker_extra_args, worker_execution_mode,
      created_at, updated_at
    FROM units_old_046
  `);

  db.exec('DROP TABLE units_old_046');

  db.exec('ALTER TABLE tasks RENAME TO tasks_old_046');

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
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE SET NULL
    )
  `);

  db.exec(`
    INSERT INTO tasks (
      id, project_id, unit_id, title, description, status, priority, tmux_window,
      source, source_ref, created_at, updated_at, self_review_count,
      self_review_max_attempts, require_plan_approval, branch, changed_files, pr_url,
      worktree_path, worktree_branch, base_branch, plan_markdown, pending_questions,
      review_subagent, implement_subagent, target_branch, summary_json, agent_session_id,
      skip_pr, working_directory, server_name
    )
    SELECT
      id, project_id, unit_id, title, description, status, priority, tmux_window,
      source, source_ref, created_at, updated_at, self_review_count,
      self_review_max_attempts, require_plan_approval, branch, changed_files, pr_url,
      worktree_path, worktree_branch, base_branch, plan_markdown, pending_questions,
      review_subagent, implement_subagent, target_branch, summary_json, agent_session_id,
      skip_pr, working_directory, server_name
    FROM tasks_old_046
  `);

  db.exec('DROP TABLE tasks_old_046');
}
