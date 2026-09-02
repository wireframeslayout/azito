import type Database from 'better-sqlite3';

export const version = 66;
export const description = 'project_servers.distribution_repository_id — explicit per-project-server distribution target repository (Issue #87), replacing the project.repositories[0]/exactly-one-repository fail-fast that stood in for it';

/**
 * SQLite cannot ALTER TABLE ADD COLUMN with a REFERENCES clause the way some
 * other engines can in-place (a column-level FOREIGN KEY added via ADD
 * COLUMN is not enforced by SQLite's own limitations around ALTER TABLE), so
 * this follows the same rename-old/create-new/copy/drop-old pattern as
 * 046_remove_orchestrator_mode.ts and 037_worker_profile_split.ts's table
 * rebuilds: rename `project_servers` aside, recreate it with every existing
 * column plus the new one, copy every row across unchanged, then drop the
 * renamed-aside table.
 *
 * `ON DELETE SET NULL` (not CASCADE): deleting a `project_repositories` row
 * must only clear the pointer to it, never delete the `project_servers` row
 * itself — a project server also carries `working_directory`/`branch`/
 * `input_policy`/`distribute_code`/`tmux_session`, none of which become
 * meaningless just because the distribution target repository was removed.
 * After the delete, `distribution_repository_id` is NULL again, and
 * DistributionHelper's fail-fast for "distribution required but no target
 * repository configured" takes over exactly as it would for a project
 * server that never had one set.
 */
export function up(db: Database.Database): void {
  db.exec('ALTER TABLE project_servers RENAME TO project_servers_old_066');

  db.exec(`
    CREATE TABLE project_servers (
      project_id INTEGER NOT NULL,
      server_name TEXT NOT NULL,
      working_directory TEXT,
      branch TEXT,
      tmux_session TEXT NOT NULL DEFAULT 'azito',
      input_policy TEXT NOT NULL DEFAULT 'manual-approval',
      distribute_code INTEGER NOT NULL DEFAULT 0,
      distribution_repository_id INTEGER,
      PRIMARY KEY (project_id, server_name),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (server_name) REFERENCES servers(name) ON DELETE CASCADE,
      FOREIGN KEY (distribution_repository_id) REFERENCES project_repositories(id) ON DELETE SET NULL
    )
  `);

  db.exec(`
    INSERT INTO project_servers (
      project_id, server_name, working_directory, branch, tmux_session, input_policy, distribute_code
    )
    SELECT
      project_id, server_name, working_directory, branch, tmux_session, input_policy, distribute_code
    FROM project_servers_old_066
  `);

  db.exec('DROP TABLE project_servers_old_066');

  // Backfill (design doc §1): for a row that already opted into
  // distribute_code, the OLD implicit target was "the project's single
  // repository" (DistributionHelper's now-removed `project.repositories[0]`
  // + "fail fast unless exactly one" guard) — make that explicit here so
  // existing configurations keep working unchanged. A project with zero or
  // more than one repository had no unambiguous implicit target before
  // either (zero: `no_repository` fail-fast; 2+: `multiple_repositories`
  // fail-fast), so those rows are deliberately left NULL — they already
  // fail fast today, and they will keep failing fast (now for "no
  // distribution target configured") until an operator explicitly picks one
  // in project settings.
  //
  // The same implicit-single-repository resolution ALSO applied to isolated
  // servers regardless of `distribute_code`: DistributionHelper's
  // requirement check is `server.type !== 'local' && (server.isolationIntent
  // || projectServer?.distributeCode)`, so a `servers.isolation_intent = 1`
  // row (isolated servers carry no git credentials of their own) needed
  // distribution just as much as a `distribute_code = 1` row, and relied on
  // the very same "project has exactly one repository" implicit resolution.
  // A `distribute_code = 0` isolated-server row must therefore be backfilled
  // too, or the upgrade silently breaks distribution for every existing
  // isolated-server configuration that depended on that implicit
  // resolution.
  const rows = db.prepare(`
    SELECT ps.project_id AS project_id, ps.server_name AS server_name
    FROM project_servers ps
    JOIN servers s ON s.name = ps.server_name
    WHERE ps.distribute_code = 1 OR s.isolation_intent = 1
  `).all() as Array<{ project_id: number; server_name: string }>;

  const findSingleRepositoryId = db.prepare(`
    SELECT id FROM project_repositories WHERE project_id = ?
  `);
  const setDistributionRepositoryId = db.prepare(`
    UPDATE project_servers SET distribution_repository_id = ? WHERE project_id = ? AND server_name = ?
  `);

  for (const row of rows) {
    const repos = findSingleRepositoryId.all(row.project_id) as Array<{ id: number }>;
    if (repos.length === 1) {
      setDistributionRepositoryId.run(repos[0].id, row.project_id, row.server_name);
    }
  }
}
