import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

// Migrations 001→041 must be replayed against a fresh in-memory DB before 042 can run
// (042 reads operations / worker_profiles / tasks / projects rows before dropping tables).
import * as m001 from './001_initial_schema';
import * as m002 from './002_legacy_migrations';
import * as m003 from './003_seed_defaults';
import * as m004 from './004_project_sidekick_prompt';
import * as m005 from './005_model_restructure';
import * as m006 from './006_task_orchestrator';
import * as m007 from './007_repository_provider';
import * as m008 from './008_fix_gitlab_repos';
import * as m009 from './009_storage_settings';
import * as m010 from './010_plan_approval';
import * as m011 from './011_push_subscriptions';
import * as m012 from './012_task_git_info';
import * as m013 from './013_project_icon_color';
import * as m014 from './014_task_worktree';
import * as m015 from './015_sidekick_max_concurrency';
import * as m016 from './016_structured_prompts';
import * as m017 from './017_pending_questions';
import * as m018 from './018_questions_json_prompt';
import * as m019 from './019_plan_in_implementing_prompt';
import * as m020 from './020_project_slug';
import * as m021 from './021_agent_servers';
import * as m022 from './022_agent_bootstrap';
import * as m023 from './023_worker_extra_args';
import * as m024 from './024_subagent_config';
import * as m025 from './025_inject_prompt_modules';
import * as m026 from './026_task_target_branch';
import * as m027 from './027_pushing_target_branch';
import * as m028 from './028_deduplicate_project_windows';
import * as m029 from './029_task_summary';
import * as m030 from './030_agent_session_id';
import * as m031 from './031_task_skip_pr';
import * as m032 from './032_task_working_directory';
import * as m033 from './033_pushing_prompt_skip_pr';
import * as m034 from './034_task_multi_window';
import * as m035 from './035_unified_windows';
import * as m036 from './036_remove_sidekick_legacy';
import * as m037 from './037_worker_profile_split';
import * as m038 from './038_rename_sidekicks_to_operations';
import * as m039 from './039_export_edited_phase_prompts';
import * as m040 from './040_operation_phase_config';
import * as m041 from './041_sidekick_tags';
import * as m042 from './042_units';

interface Migration {
  version: number;
  up: (db: Database.Database) => void;
}

const PRIOR_MIGRATIONS: Migration[] = [
  m001, m002, m003, m004, m005, m006, m007, m008, m009, m010,
  m011, m012, m013, m014, m015, m016, m017, m018, m019, m020,
  m021, m022, m023, m024, m025, m026, m027, m028, m029, m030,
  m031, m032, m033, m034, m035, m036, m037, m038, m039, m040, m041,
];

// Same table-rebuild toggle as the real migration runner in Database.ts.
const MIGRATIONS_REQUIRING_TABLE_REBUILD = new Set([36, 37, 42]);

function buildSeededDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const migration of PRIOR_MIGRATIONS) {
    const needsRebuild = MIGRATIONS_REQUIRING_TABLE_REBUILD.has(migration.version);
    if (needsRebuild) {
      db.pragma('foreign_keys = OFF');
      db.pragma('legacy_alter_table = ON');
    }
    db.transaction(() => migration.up(db))();
    if (needsRebuild) {
      db.pragma('legacy_alter_table = OFF');
      db.pragma('foreign_keys = ON');
    }
  }
  return db;
}

function runM042(db: Database.Database): void {
  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = ON');
  db.transaction(() => m042.up(db))();
  db.pragma('legacy_alter_table = OFF');
  db.pragma('foreign_keys = ON');
}

function insertProject(db: Database.Database, name: string): number {
  return Number(db.prepare('INSERT INTO projects (name, slug) VALUES (?, ?)').run(name, name).lastInsertRowid);
}

function insertOperation(db: Database.Database, name: string): number {
  return Number(db.prepare('INSERT INTO operations (name) VALUES (?)').run(name).lastInsertRowid);
}

function insertWorkerProfile(db: Database.Database, name: string, workerType: string, orchestratorMode = 'state-machine'): number {
  return Number(
    db.prepare('INSERT INTO worker_profiles (name, worker_type, orchestrator_mode) VALUES (?, ?, ?)').run(name, workerType, orchestratorMode)
      .lastInsertRowid,
  );
}

function insertTask(
  db: Database.Database,
  projectId: number,
  operationId: number,
  workerProfileId: number | null,
): number {
  return Number(
    db.prepare('INSERT INTO tasks (project_id, operation_id, worker_profile_id, title) VALUES (?, ?, ?, ?)')
      .run(projectId, operationId, workerProfileId, `task for op ${operationId}`).lastInsertRowid,
  );
}

describe('migration 042: merge Operation + WorkerProfile into Unit', () => {
  it('creates a units row per operation, carrying over behavior columns', () => {
    const db = buildSeededDb();
    const opId = insertOperation(db, 'my-op');
    db.prepare('UPDATE operations SET system_prompt = ?, self_review_max_attempts = ? WHERE id = ?').run('sys', 3, opId);

    runM042(db);

    const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(opId) as Record<string, unknown>;
    expect(unit.name).toBe('my-op');
    expect(unit.system_prompt).toBe('sys');
    expect(unit.self_review_max_attempts).toBe(3);
  });

  it('drops the operations and worker_profiles tables', () => {
    const db = buildSeededDb();
    insertOperation(db, 'op-a');
    insertWorkerProfile(db, 'profile-a', 'claude');

    runM042(db);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('operations', 'worker_profiles')").all();
    expect(tables).toHaveLength(0);
  });

  it('resolves runtime fields from the latest task\'s own worker_profile (priority 1)', () => {
    const db = buildSeededDb();
    const projectId = insertProject(db, 'proj-a');
    const opId = insertOperation(db, 'op-a');
    const profileId = insertWorkerProfile(db, 'profile-a', 'claude', 'llm');
    insertTask(db, projectId, opId, profileId);

    runM042(db);

    const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(opId) as Record<string, unknown>;
    expect(unit.worker_type).toBe('claude');
    expect(unit.orchestrator_mode).toBe('llm');
  });

  it('falls back to the latest task\'s project default_worker_profile_id (priority 2)', () => {
    const db = buildSeededDb();
    const projectId = insertProject(db, 'proj-b');
    const opId = insertOperation(db, 'op-b');
    const profileId = insertWorkerProfile(db, 'profile-b', 'codex');
    db.prepare('UPDATE projects SET default_worker_profile_id = ? WHERE id = ?').run(profileId, projectId);
    insertTask(db, projectId, opId, null);

    runM042(db);

    const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(opId) as Record<string, unknown>;
    expect(unit.worker_type).toBe('codex');
  });

  it('uses the sole worker_profile when an operation has no task at all (priority 3)', () => {
    const db = buildSeededDb();
    const opId = insertOperation(db, 'unused-op');
    insertWorkerProfile(db, 'only-profile', 'aider');

    runM042(db);

    const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(opId) as Record<string, unknown>;
    expect(unit.worker_type).toBe('aider');
  });

  it('falls back to NULL/state-machine when multiple worker_profiles exist and none resolve (priority 4)', () => {
    const db = buildSeededDb();
    const opId = insertOperation(db, 'ambiguous-op');
    insertWorkerProfile(db, 'profile-x', 'claude');
    insertWorkerProfile(db, 'profile-y', 'codex');

    runM042(db);

    const unit = db.prepare('SELECT * FROM units WHERE id = ?').get(opId) as Record<string, unknown>;
    expect(unit.worker_type).toBeNull();
    expect(unit.worker_model).toBeNull();
    expect(unit.worker_extra_args).toBeNull();
    expect(unit.orchestrator_mode).toBe('state-machine');
  });

  it('backfills tasks.unit_id from operation_id and drops operation_id/worker_profile_id', () => {
    const db = buildSeededDb();
    const projectId = insertProject(db, 'proj-c');
    const opId = insertOperation(db, 'op-c');
    const profileId = insertWorkerProfile(db, 'profile-c', 'claude');
    const taskId = insertTask(db, projectId, opId, profileId);

    runM042(db);

    const columns = (db.prepare("PRAGMA table_info('tasks')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain('unit_id');
    expect(columns).not.toContain('operation_id');
    expect(columns).not.toContain('worker_profile_id');

    const task = db.prepare('SELECT unit_id FROM tasks WHERE id = ?').get(taskId) as { unit_id: number };
    expect(task.unit_id).toBe(opId);
  });

  it('renames execution_log.operation_id to unit_id and preserves values', () => {
    const db = buildSeededDb();
    const projectId = insertProject(db, 'proj-d');
    const opId = insertOperation(db, 'op-d');
    const taskId = insertTask(db, projectId, opId, null);
    db.prepare('INSERT INTO execution_log (task_id, operation_id, type, content) VALUES (?, ?, ?, ?)').run(taskId, opId, 'output', 'hello');

    runM042(db);

    const columns = (db.prepare("PRAGMA table_info('execution_log')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain('unit_id');
    expect(columns).not.toContain('operation_id');

    const log = db.prepare('SELECT unit_id, content FROM execution_log WHERE task_id = ?').get(taskId) as { unit_id: number; content: string };
    expect(log.unit_id).toBe(opId);
    expect(log.content).toBe('hello');
  });

  it('replaces projects.default_worker_profile_id with default_unit_id, backfilled from the latest task\'s unit', () => {
    const db = buildSeededDb();
    const projectId = insertProject(db, 'proj-e');
    const opOld = insertOperation(db, 'op-old');
    const opNew = insertOperation(db, 'op-new');
    insertTask(db, projectId, opOld, null);
    // Insert the newer task with a later created_at so it wins the "latest task" tie-break.
    const newTaskId = insertTask(db, projectId, opNew, null);
    db.prepare("UPDATE tasks SET created_at = datetime('now', '+1 hour') WHERE id = ?").run(newTaskId);

    runM042(db);

    const columns = (db.prepare("PRAGMA table_info('projects')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toContain('default_unit_id');
    expect(columns).not.toContain('default_worker_profile_id');

    const project = db.prepare('SELECT default_unit_id FROM projects WHERE id = ?').get(projectId) as { default_unit_id: number };
    expect(project.default_unit_id).toBe(opNew);
  });

  it('leaves projects.default_unit_id NULL when the project has no tasks', () => {
    const db = buildSeededDb();
    const projectId = insertProject(db, 'proj-f');

    runM042(db);

    const project = db.prepare('SELECT default_unit_id FROM projects WHERE id = ?').get(projectId) as { default_unit_id: number | null };
    expect(project.default_unit_id).toBeNull();
  });

  it('does not carry an orphaned worker_profile (unused by any task/project) into any unit, and logs it', () => {
    const db = buildSeededDb();
    const projectId = insertProject(db, 'proj-g');
    const opId = insertOperation(db, 'op-g');
    const usedProfileId = insertWorkerProfile(db, 'used-profile', 'claude');
    insertWorkerProfile(db, 'orphan-profile', 'codex');
    insertTask(db, projectId, opId, usedProfileId);

    const logSpy = console.log;
    let logged = '';
    console.log = (msg: string) => { logged += msg; };
    try {
      runM042(db);
    } finally {
      console.log = logSpy;
    }

    expect(logged).toContain('orphan-profile');
    const unit = db.prepare('SELECT worker_type FROM units WHERE id = ?').get(opId) as { worker_type: string };
    expect(unit.worker_type).toBe('claude');
  });

  it('preserves the FK chain: deleting a unit sets tasks.unit_id to NULL', () => {
    const db = buildSeededDb();
    const projectId = insertProject(db, 'proj-h');
    const opId = insertOperation(db, 'op-h');
    const taskId = insertTask(db, projectId, opId, null);

    runM042(db);

    db.prepare('DELETE FROM units WHERE id = ?').run(opId);
    const task = db.prepare('SELECT unit_id FROM tasks WHERE id = ?').get(taskId) as { unit_id: number | null };
    expect(task.unit_id).toBeNull();
  });

  it('has exactly migration-020 idx_projects_slug (and no triggers) on the rebuilt tables before 042 (guards the index-recreation list)', () => {
    // 042 recreates, by name, every index that existed on a rebuilt table
    // (tasks / execution_log / projects). If a migration in the 001-041 range
    // ever adds another index or a trigger to one of these tables, this test
    // fails so the recreation step in 042 gets extended accordingly.
    const db = buildSeededDb();
    const rows = db.prepare(
      "SELECT type, name FROM sqlite_master WHERE type IN ('index', 'trigger') AND tbl_name IN ('tasks', 'execution_log', 'projects') AND name NOT LIKE 'sqlite_autoindex%'",
    ).all() as Array<{ type: string; name: string }>;
    expect(rows).toEqual([{ type: 'index', name: 'idx_projects_slug' }]);
  });

  it('recreates the unique projects.slug index after the projects rebuild', () => {
    const db = buildSeededDb();
    runM042(db);

    const index = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_projects_slug' AND tbl_name = 'projects'",
    ).get();
    expect(index).toBeDefined();
  });

  it('rejects duplicate project slugs after migration (slug uniqueness enforced)', () => {
    const db = buildSeededDb();
    db.prepare('INSERT INTO projects (name, slug) VALUES (?, ?)').run('proj-x', 'same-slug');

    runM042(db);

    expect(() => {
      db.prepare('INSERT INTO projects (name, slug) VALUES (?, ?)').run('proj-y', 'same-slug');
    }).toThrow(/UNIQUE/);
  });
});
