import type Database from 'better-sqlite3';

export const version = 42;
export const description = 'Merge Operation (behavior) + WorkerProfile (runtime) into a single Unit entity; Operation becomes "one execution run of a Unit" (Issue #263 Refine B)';

/**
 * Refine B of the Sidekick redesign (Issue #263): the split introduced in
 * migrations 037 (WorkerProfile split out) / 038 (sidekicks → operations
 * rename) is undone in favor of a single `units` table: a Unit is "the team
 * that runs an operation" and owns both behavior (system_prompt,
 * self_review_max_attempts, review/implement subagent config, phase_config)
 * and runtime (worker_type/worker_model/worker_extra_args/orchestrator_mode).
 * "Operation" is repurposed to mean one execution run of a Unit — the
 * existing `ExecuteTaskUseCase.getRunning()` running-executions map is that
 * run registry; there is no `operations` table anymore.
 *
 * `tasks.operation_id`/`tasks.worker_profile_id` collapse into a single
 * `tasks.unit_id`. `execution_log.operation_id` is renamed to `unit_id`.
 * `projects.default_worker_profile_id` becomes `projects.default_unit_id`.
 *
 * Runtime value resolution (per old Operation row, in priority order):
 *   1. The worker_profile of the most recent task (created_at DESC, id DESC)
 *      that used this operation: task.worker_profile_id, falling back to
 *      that task's project.default_worker_profile_id (mirrors the existing
 *      app-level resolution in TaskExecutionEnv.resolveWorkerProfileId).
 *   2. If no task used this operation, or the resolved profile id does not
 *      exist: the sole worker_profiles row, IF worker_profiles has exactly
 *      one row total.
 *   3. Otherwise: NULL for worker_type/worker_model/worker_extra_args,
 *      'state-machine' for orchestrator_mode (the column's own default).
 *
 * `units.id` is inserted explicitly equal to the source operation's id, so
 * `tasks.unit_id`/`execution_log.unit_id` can be backfilled directly from the
 * old operation_id values without an id-remapping table.
 *
 * `tasks`, `execution_log`, and `projects` all need columns dropped that
 * carry inline FOREIGN KEY constraints (tasks.operation_id →
 * "operations"(id), tasks.worker_profile_id → worker_profiles(id),
 * projects.default_worker_profile_id → worker_profiles(id)), which SQLite's
 * `ALTER TABLE ... DROP COLUMN` refuses ("column is part of ... foreign key
 * definition"). All three are rebuilt (RENAME + CREATE + copy + DROP), same
 * as migrations 036/037. `tasks` and `projects` are themselves referenced by
 * other tables' FOREIGN KEY constraints (execution_log.task_id,
 * windows.task_id, windows.project_id, project_servers.project_id, etc.), so
 * — again as in 036/037 — the whole migration runs with `foreign_keys OFF`
 * and `legacy_alter_table ON` (toggled by Database.ts's
 * MIGRATIONS_REQUIRING_TABLE_REBUILD) so no rename auto-rewrites a
 * referencing table's stored FK clause to a temporary name. Every rebuilt
 * table's FOREIGN KEY clauses are written out fresh with their final literal
 * table names (`units`, `projects`, `tasks`), so correctness does not depend
 * on that auto-rewrite behavior at all.
 *
 * Ordering: `units` is built first (from `operations` + `worker_profiles` +
 * the OLD tasks/projects columns, all still present). `tasks` is rebuilt
 * next (so the new `projects` rebuild can read `tasks.unit_id` to compute
 * `default_unit_id`). `execution_log` and `projects` follow. `operations` and
 * `worker_profiles` are dropped last, once nothing references them anymore.
 */
export function up(db: Database.Database): void {
  interface OperationRow {
    id: number;
    name: string;
    system_prompt: string | null;
    self_review_max_attempts: number;
    review_subagent: string | null;
    implement_subagent: string | null;
    phase_config: string | null;
    created_at: string;
    updated_at: string;
  }

  interface WorkerProfileRow {
    id: number;
    name: string;
    worker_type: string | null;
    worker_model: string | null;
    worker_extra_args: string | null;
    orchestrator_mode: string;
  }

  interface OldTaskRow {
    id: number;
    project_id: number;
    operation_id: number | null;
    worker_profile_id: number | null;
    created_at: string;
  }

  interface OldProjectRow {
    id: number;
    default_worker_profile_id: number | null;
  }

  const operations = db.prepare(
    'SELECT id, name, system_prompt, self_review_max_attempts, review_subagent, implement_subagent, phase_config, created_at, updated_at FROM operations',
  ).all() as OperationRow[];

  const workerProfiles = db.prepare(
    'SELECT id, name, worker_type, worker_model, worker_extra_args, orchestrator_mode FROM worker_profiles',
  ).all() as WorkerProfileRow[];
  const profilesById = new Map<number, WorkerProfileRow>(workerProfiles.map((p) => [p.id, p]));

  const oldTasks = db.prepare(
    'SELECT id, project_id, operation_id, worker_profile_id, created_at FROM tasks',
  ).all() as OldTaskRow[];

  const oldProjects = db.prepare(
    'SELECT id, default_worker_profile_id FROM projects',
  ).all() as OldProjectRow[];
  const projectsById = new Map<number, OldProjectRow>(oldProjects.map((p) => [p.id, p]));

  // Latest task per operation_id (created_at DESC, id DESC — same tie-break as
  // the app's resolveTaskServerName / resolveWorkerProfileId call sites).
  const latestTaskByOperation = new Map<number, OldTaskRow>();
  for (const t of oldTasks) {
    if (t.operation_id === null) continue;
    const current = latestTaskByOperation.get(t.operation_id);
    if (!current || t.created_at > current.created_at || (t.created_at === current.created_at && t.id > current.id)) {
      latestTaskByOperation.set(t.operation_id, t);
    }
  }

  const soleWorkerProfile = workerProfiles.length === 1 ? workerProfiles[0] : null;
  const usedProfileIds = new Set<number>();

  interface RuntimeFields {
    workerType: string | null;
    workerModel: string | null;
    workerExtraArgs: string | null;
    orchestratorMode: string;
  }

  function resolveRuntime(operationId: number): RuntimeFields {
    const latestTask = latestTaskByOperation.get(operationId);
    if (latestTask) {
      const resolvedProfileId = latestTask.worker_profile_id ?? projectsById.get(latestTask.project_id)?.default_worker_profile_id ?? null;
      if (resolvedProfileId !== null) {
        const profile = profilesById.get(resolvedProfileId);
        if (profile) {
          usedProfileIds.add(profile.id);
          return {
            workerType: profile.worker_type,
            workerModel: profile.worker_model,
            workerExtraArgs: profile.worker_extra_args,
            orchestratorMode: profile.orchestrator_mode || 'state-machine',
          };
        }
      }
    }
    if (soleWorkerProfile) {
      usedProfileIds.add(soleWorkerProfile.id);
      return {
        workerType: soleWorkerProfile.worker_type,
        workerModel: soleWorkerProfile.worker_model,
        workerExtraArgs: soleWorkerProfile.worker_extra_args,
        orchestratorMode: soleWorkerProfile.orchestrator_mode || 'state-machine',
      };
    }
    return { workerType: null, workerModel: null, workerExtraArgs: null, orchestratorMode: 'state-machine' };
  }

  // ─── 1. units table ───

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
      orchestrator_mode TEXT NOT NULL DEFAULT 'state-machine',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const insertUnit = db.prepare(`
    INSERT INTO units (
      id, name, system_prompt, self_review_max_attempts, review_subagent, implement_subagent,
      phase_config, worker_type, worker_model, worker_extra_args, orchestrator_mode,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const op of operations) {
    const runtime = resolveRuntime(op.id);
    insertUnit.run(
      op.id,
      op.name,
      op.system_prompt,
      op.self_review_max_attempts,
      op.review_subagent,
      op.implement_subagent,
      op.phase_config,
      runtime.workerType,
      runtime.workerModel,
      runtime.workerExtraArgs,
      runtime.orchestratorMode,
      op.created_at,
      op.updated_at,
    );
  }

  const orphanProfiles = workerProfiles.filter((p) => !usedProfileIds.has(p.id));
  if (orphanProfiles.length > 0) {
    console.log(`[migration 042] Orphaned worker_profiles not carried over to any unit: ${orphanProfiles.map((p) => p.name).join(', ')}`);
  }

  // ─── 2. Rebuild tasks: operation_id + worker_profile_id → unit_id ───

  db.exec('ALTER TABLE tasks RENAME TO tasks_old_042');

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
      orchestrator_mode TEXT DEFAULT NULL,
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
      source, source_ref, created_at, updated_at, self_review_count, orchestrator_mode,
      self_review_max_attempts, require_plan_approval, branch, changed_files, pr_url,
      worktree_path, worktree_branch, base_branch, plan_markdown, pending_questions,
      review_subagent, implement_subagent, target_branch, summary_json, agent_session_id,
      skip_pr, working_directory, server_name
    )
    SELECT
      id, project_id, operation_id, title, description, status, priority, tmux_window,
      source, source_ref, created_at, updated_at, self_review_count, orchestrator_mode,
      self_review_max_attempts, require_plan_approval, branch, changed_files, pr_url,
      worktree_path, worktree_branch, base_branch, plan_markdown, pending_questions,
      review_subagent, implement_subagent, target_branch, summary_json, agent_session_id,
      skip_pr, working_directory, server_name
    FROM tasks_old_042
  `);

  db.exec('DROP TABLE tasks_old_042');

  // ─── 3. Rebuild execution_log: operation_id → unit_id ───

  db.exec('ALTER TABLE execution_log RENAME TO execution_log_old_042');

  db.exec(`
    CREATE TABLE execution_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      unit_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      content TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE SET NULL,
      FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    INSERT INTO execution_log (id, task_id, unit_id, type, content, created_at)
    SELECT id, task_id, operation_id, type, content, created_at
    FROM execution_log_old_042
  `);

  db.exec('DROP TABLE execution_log_old_042');

  // ─── 4. Rebuild projects: default_worker_profile_id → default_unit_id ───

  const defaultUnitByProject = new Map<number, number>();
  const findLatestTaskUnit = db.prepare(`
    SELECT unit_id FROM tasks
    WHERE project_id = ? AND unit_id IS NOT NULL
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `);
  for (const project of oldProjects) {
    const latest = findLatestTaskUnit.get(project.id) as { unit_id: number } | undefined;
    if (latest) defaultUnitByProject.set(project.id, latest.unit_id);
  }

  db.exec('ALTER TABLE projects RENAME TO projects_old_042');

  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      working_directory TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      sidekick_prompt TEXT,
      repository_url TEXT,
      default_branch TEXT DEFAULT 'main',
      icon TEXT,
      color TEXT,
      slug TEXT,
      default_unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL
    )
  `);

  db.exec(`
    INSERT INTO projects (
      id, name, description, working_directory, created_at, updated_at,
      sidekick_prompt, repository_url, default_branch, icon, color, slug, default_unit_id
    )
    SELECT
      id, name, description, working_directory, created_at, updated_at,
      sidekick_prompt, repository_url, default_branch, icon, color, slug, NULL
    FROM projects_old_042
  `);

  const updateProjectDefaultUnit = db.prepare('UPDATE projects SET default_unit_id = ? WHERE id = ?');
  for (const [projectId, unitId] of defaultUnitByProject) {
    updateProjectDefaultUnit.run(unitId, projectId);
  }

  db.exec('DROP TABLE projects_old_042');

  // Recreate indexes lost by the table rebuilds. Renaming a table carries its
  // indexes/triggers along to the _old_042 name, and DROP TABLE then drops them
  // with it — the freshly created replacement table doesn't inherit any.
  // Checked against sqlite_master at 041-state: the only index on any rebuilt
  // table (tasks / execution_log / projects) is migration 020's unique slug
  // index on projects; tasks and execution_log have no indexes, and no rebuilt
  // table has triggers.
  db.exec('CREATE UNIQUE INDEX idx_projects_slug ON projects(slug)');

  // ─── 5. Drop operations / worker_profiles ───

  db.exec('DROP TABLE operations');
  db.exec('DROP TABLE worker_profiles');
}
