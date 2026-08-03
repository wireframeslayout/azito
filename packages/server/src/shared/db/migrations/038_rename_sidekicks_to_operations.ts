import type Database from 'better-sqlite3';

export const version = 38;
export const description = 'Rename sidekicks table (and FK columns) to operations, freeing the "Sidekick" name for the Phase 4+ skill-package concept';

/**
 * Phase 3 of the Sidekick redesign (Issue #263): pure rename. The `sidekicks`
 * table (behavior-only since migration 037: name/system_prompt/
 * self_review_max_attempts/review_subagent/implement_subagent) becomes
 * `operations`. `tasks.sidekick_id` and `execution_log.sidekick_id` become
 * `operation_id`.
 *
 * Unlike migrations 036/037, this does not drop or restructure any columns,
 * so no table rebuild is required. `ALTER TABLE sidekicks RENAME TO
 * operations` uses SQLite's standard (non-legacy_alter_table) rename
 * behavior, which auto-rewrites the inline FOREIGN KEY clauses in `tasks`
 * and `execution_log` to reference `operations(id)` instead of
 * `sidekicks(id)`. The subsequent `RENAME COLUMN` statements likewise
 * auto-rewrite the same-table FK child-key clause to the new column name.
 *
 * NOT renamed (explicitly out of scope, see Issue #263 Phase 3 plan):
 * `projects.sidekick_prompt` and the `{{project.sidekickPrompt}}` template
 * variable — kept for DB/template compatibility until Phase 4+.
 */
export function up(db: Database.Database): void {
  db.exec('ALTER TABLE sidekicks RENAME TO operations');
  db.exec('ALTER TABLE tasks RENAME COLUMN sidekick_id TO operation_id');
  db.exec('ALTER TABLE execution_log RENAME COLUMN sidekick_id TO operation_id');
}
