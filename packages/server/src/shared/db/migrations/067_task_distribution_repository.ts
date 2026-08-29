import type Database from 'better-sqlite3';

export const version = 67;
export const description = 'tasks.distribution_repository_id — persists which project_repositories row fetch distribution actually pulled a task\'s code from (Issue #87 review follow-up, Important finding 1), so resume never re-resolves the distribution target from the project/project-server\'s THEN-current configuration';

/**
 * A plain `ALTER TABLE ... ADD COLUMN` (Issue #87 review, forge/87-mirror
 * follow-up, Minor finding 3) — unlike 066 (`project_servers`), this column
 * carries deliberately NO `FOREIGN KEY` constraint (see below), so none of
 * the reasons that force a rebuild (066's own doc comment; SQLite's
 * `ALTER TABLE ADD COLUMN` cannot reliably add an ENFORCED foreign key)
 * apply here. `tasks` IS referenced by other tables via FOREIGN KEY
 * (`task_tokens`, `windows`, `execution_log`, `agent_turns`, ...), but a
 * bare `ADD COLUMN` never touches those relationships — the previous
 * rename/create/copy/drop rebuild bought no constraint this table doesn't
 * already get for free from a direct `ADD COLUMN`, only extra startup time,
 * temporary disk, and FK-pragma juggling this table's rebuild required
 * (RENAME/CREATE/COPY/DROP, `foreign_keys`/`legacy_alter_table` toggling)
 * for zero benefit. This migration has never shipped in any deployed
 * environment (branch-local only), so it was safe to rewrite in place
 * rather than adding a corrective 068.
 *
 * `distribution_repository_id` carries deliberately NO `FOREIGN KEY`
 * constraint at all: this column is a PROVENANCE record — "which repository
 * did this task's working-directory code actually come from at
 * distribution time" — not a referential-integrity pointer. A
 * `SET NULL`/CASCADE action fires the instant the referenced
 * `project_repositories` row is deleted, which is exactly the normal,
 * unremarkable operation of removing a repository from a project — and it
 * would silently erase the one fact this column exists to preserve. Once
 * erased, `ExecuteTaskUseCase.resumeStateMachine()` (and the shared
 * `resolveRecordedDistributionRepositoryEntry()` helper) can no longer tell
 * "this task recorded repository X, which is now gone — fail closed" apart
 * from "this task never went through distribution — fall back to the
 * project's current config", and silently takes the second, wrong branch. A
 * plain `INTEGER` column with no FK preserves a deleted repository's id
 * indefinitely: `resolveRecordedDistributionRepositoryEntry()` looks it up
 * against `project.repositories` itself and treats "id set but not found"
 * as fail-closed — the correct behavior, and the reason this column exists
 * in the first place. (RESTRICT was also considered and rejected: it would
 * make deleting a repository fail outright for as long as any task, however
 * old or finished, still references it, which is worse than either
 * alternative.)
 *
 * Existing tasks are backfilled to NULL by `ADD COLUMN`'s own default (not
 * derived from `project_servers.distribution_repository_id`): a task that
 * ran before this column existed has no record of which repository its
 * ALREADY-DISTRIBUTED working directory actually came from, and the current
 * `project_servers.distribution_repository_id` may have changed since —
 * inferring one now would reintroduce exactly the bug this migration exists
 * to fix. `resumeStateMachine()`'s "no recorded value" branch falls back to
 * resolving from the current project/project-server config, matching this
 * column's pre-existing (bug-carrying) behavior for these rows — unchanged
 * for a task whose execution never required distribution in the first
 * place, and no worse than before this fix for one that did.
 */
export function up(db: Database.Database): void {
  db.exec('ALTER TABLE tasks ADD COLUMN distribution_repository_id INTEGER');
}
