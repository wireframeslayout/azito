import type Database from 'better-sqlite3';

export const version = 37;
export const description = 'Split WorkerProfile (what runs) and serverName/tmuxSession (where it runs) out of sidekicks';

/**
 * Phase 2 of the Sidekick redesign (Issue #263): sidekicks keeps only
 * behavior (system_prompt, self_review_max_attempts, review/implement
 * subagent config). Everything about "what runs it"
 * (worker_type/worker_model/worker_extra_args/orchestrator_mode) moves to a
 * new `worker_profiles` table; "where it runs"
 * (server_name/tmux_session) moves to `tasks.server_name` (per-task
 * override) + `project_servers.tmux_session` (per project/server).
 *
 * `server_name` carries an inline FOREIGN KEY on the sidekicks table, so
 * (same as migration 036) dropping it requires a full table rebuild rather
 * than `ALTER TABLE ... DROP COLUMN`. See Database.ts's
 * MIGRATIONS_REQUIRING_TABLE_REBUILD comment for why `foreign_keys` and
 * `legacy_alter_table` are toggled around this migration's transaction.
 *
 * Ordering: all data backfills that read the OLD sidekicks columns
 * (worker_type/worker_model/worker_extra_args/orchestrator_mode/server_name/
 * tmux_session) run BEFORE the sidekicks table is rebuilt without them.
 */
export function up(db: Database.Database): void {
  interface OldSidekickRow {
    id: number;
    name: string;
    server_name: string;
    tmux_session: string;
    worker_type: string | null;
    worker_extra_args: string | null;
    worker_model: string | null;
    orchestrator_mode: string;
  }

  const oldSidekicks = db.prepare(
    'SELECT id, name, server_name, tmux_session, worker_type, worker_extra_args, worker_model, orchestrator_mode FROM sidekicks ORDER BY id ASC',
  ).all() as OldSidekickRow[];

  // ─── 1. worker_profiles table ───

  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      worker_type TEXT,
      worker_model TEXT,
      worker_extra_args TEXT,
      orchestrator_mode TEXT NOT NULL DEFAULT 'state-machine',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Group sidekicks by (worker_type, worker_model, worker_extra_args, orchestrator_mode)
  // combination, one worker_profiles row per distinct combination, named after
  // the lowest-id sidekick with that combination (colliding names get a -2, -3, ... suffix).
  const comboKey = (r: OldSidekickRow): string =>
    JSON.stringify([r.worker_type, r.worker_model, r.worker_extra_args, r.orchestrator_mode]);

  const insertProfile = db.prepare(
    'INSERT INTO worker_profiles (name, worker_type, worker_model, worker_extra_args, orchestrator_mode) VALUES (?, ?, ?, ?, ?)',
  );

  const usedNames = new Set<string>();
  const comboToProfileId = new Map<string, number>();
  const sidekickIdToProfileId = new Map<number, number>();

  for (const row of oldSidekicks) {
    const key = comboKey(row);
    let profileId = comboToProfileId.get(key);
    if (profileId === undefined) {
      let candidateName = row.name;
      let suffix = 2;
      while (usedNames.has(candidateName)) {
        candidateName = `${row.name}-${suffix}`;
        suffix++;
      }
      usedNames.add(candidateName);
      const result = insertProfile.run(
        candidateName,
        row.worker_type,
        row.worker_model,
        row.worker_extra_args,
        row.orchestrator_mode || 'state-machine',
      );
      profileId = Number(result.lastInsertRowid);
      comboToProfileId.set(key, profileId);
    }
    sidekickIdToProfileId.set(row.id, profileId);
  }

  // ─── 2. tasks.worker_profile_id / tasks.server_name ───

  db.exec('ALTER TABLE tasks ADD COLUMN worker_profile_id INTEGER REFERENCES worker_profiles(id) ON DELETE SET NULL');
  db.exec('ALTER TABLE tasks ADD COLUMN server_name TEXT REFERENCES servers(name) ON DELETE SET NULL');

  const sidekickNameById = new Map<number, string>(oldSidekicks.map((r) => [r.id, r.server_name]));

  const tasks = db.prepare('SELECT id, sidekick_id FROM tasks').all() as Array<{ id: number; sidekick_id: number | null }>;
  const updateTaskEnv = db.prepare('UPDATE tasks SET worker_profile_id = ?, server_name = ? WHERE id = ?');

  for (const task of tasks) {
    const profileId = task.sidekick_id !== null ? sidekickIdToProfileId.get(task.sidekick_id) ?? null : null;
    const serverName = task.sidekick_id !== null ? sidekickNameById.get(task.sidekick_id) ?? null : null;
    updateTaskEnv.run(profileId, serverName, task.id);
  }

  // ─── 3. projects.default_worker_profile_id ───

  db.exec('ALTER TABLE projects ADD COLUMN default_worker_profile_id INTEGER REFERENCES worker_profiles(id) ON DELETE SET NULL');

  const projects = db.prepare('SELECT id FROM projects').all() as Array<{ id: number }>;
  const findLatestTaskWithProfile = db.prepare(`
    SELECT worker_profile_id FROM tasks
    WHERE project_id = ? AND worker_profile_id IS NOT NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `);
  const updateProjectDefault = db.prepare('UPDATE projects SET default_worker_profile_id = ? WHERE id = ?');

  for (const project of projects) {
    const latest = findLatestTaskWithProfile.get(project.id) as { worker_profile_id: number } | undefined;
    updateProjectDefault.run(latest?.worker_profile_id ?? null, project.id);
  }

  // ─── 4. project_servers.tmux_session ───

  db.exec("ALTER TABLE project_servers ADD COLUMN tmux_session TEXT NOT NULL DEFAULT 'azito'");

  // Backfill per (project_id, server_name) — NOT per server_name alone, because the
  // same server may host different tmux sessions for different projects. Decision
  // rule, in priority order:
  //   1. tmux_session of the sidekick used by the most recent task (created_at DESC,
  //      id DESC) of THIS project on THIS server (tasks.server_name was backfilled
  //      from each task's sidekick in step 2 above, so this join is consistent).
  //   2. tmux_session of the lowest-id sidekick whose server_name matches this server
  //      (server-level fallback for project/server pairs that never ran a task).
  //   3. 'azito' (the column's DB default — leave the row untouched).
  const tmuxSessionBySidekickId = new Map<number, string>(oldSidekicks.map((r) => [r.id, r.tmux_session]));
  const tmuxSessionByServerName = new Map<string, string>();
  for (const row of oldSidekicks) {
    if (!tmuxSessionByServerName.has(row.server_name)) {
      tmuxSessionByServerName.set(row.server_name, row.tmux_session);
    }
  }

  const findLatestTaskSidekick = db.prepare(`
    SELECT sidekick_id FROM tasks
    WHERE project_id = ? AND server_name = ? AND sidekick_id IS NOT NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `);

  const projectServers = db.prepare('SELECT project_id, server_name FROM project_servers').all() as Array<{ project_id: number; server_name: string }>;
  const updateProjectServerSession = db.prepare('UPDATE project_servers SET tmux_session = ? WHERE project_id = ? AND server_name = ?');

  for (const ps of projectServers) {
    const latestTask = findLatestTaskSidekick.get(ps.project_id, ps.server_name) as { sidekick_id: number } | undefined;
    const tmuxSession =
      (latestTask !== undefined ? tmuxSessionBySidekickId.get(latestTask.sidekick_id) : undefined)
      ?? tmuxSessionByServerName.get(ps.server_name);
    if (tmuxSession) {
      updateProjectServerSession.run(tmuxSession, ps.project_id, ps.server_name);
    }
  }

  // ─── 5. Rebuild sidekicks without worker_type/worker_extra_args/worker_model/
  //         orchestrator_mode/server_name/tmux_session ───

  db.exec('ALTER TABLE sidekicks RENAME TO sidekicks_old_037');

  db.exec(`
    CREATE TABLE sidekicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      system_prompt TEXT,
      self_review_max_attempts INTEGER NOT NULL DEFAULT 2,
      review_subagent TEXT,
      implement_subagent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    INSERT INTO sidekicks (
      id, name, system_prompt, self_review_max_attempts, review_subagent,
      implement_subagent, created_at, updated_at
    )
    SELECT
      id, name, system_prompt, self_review_max_attempts, review_subagent,
      implement_subagent, created_at, updated_at
    FROM sidekicks_old_037
  `);

  db.exec('DROP TABLE sidekicks_old_037');
}
