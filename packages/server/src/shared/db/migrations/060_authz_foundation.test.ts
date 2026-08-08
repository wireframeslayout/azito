import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

// Migrations 001->059 must be replayed against a fresh in-memory DB before 060 can run.
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
import * as m043 from './043_agent_turns';
import * as m044 from './044_agent_watches';
import * as m045 from './045_server_mux_runtime';
import * as m046 from './046_remove_orchestrator_mode';
import * as m047 from './047_task_current_phase';
import * as m048 from './048_unit_type_column';
import * as m049 from './049_worker_runtime';
import * as m050 from './050_window_supervised';
import * as m051 from './051_resource_guard_settings';
import * as m052 from './052_project_secrets';
import * as m053 from './053_browser_tab_snapshots';
import * as m054 from './054_ssh_host_fingerprint';
import * as m055 from './055_reduce_worker_execution_mode';
import * as m056 from './056_drop_windows_supervised';
import * as m057 from './057_push_subscription_lang';
import * as m058 from './058_disable_ssh_servers';
import * as m059 from './059_input_trust_and_exec_gate';
import * as m060 from './060_authz_foundation';

interface Migration {
  version: number;
  up: (db: Database.Database) => void;
}

const PRIOR_MIGRATIONS: Migration[] = [
  m001, m002, m003, m004, m005, m006, m007, m008, m009, m010,
  m011, m012, m013, m014, m015, m016, m017, m018, m019, m020,
  m021, m022, m023, m024, m025, m026, m027, m028, m029, m030,
  m031, m032, m033, m034, m035, m036, m037, m038, m039, m040,
  m041, m042, m043, m044, m045, m046, m047, m048, m049, m050,
  m051, m052, m053, m054, m055, m056, m057, m058, m059,
];

// Same table-rebuild toggle as the real migration runner in Database.ts.
const MIGRATIONS_REQUIRING_TABLE_REBUILD = new Set([36, 37, 42, 46]);

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
  db.prepare(`INSERT INTO projects (id, name, slug) VALUES (1, 'Test Project', 'test-project')`).run();
  db.prepare(`INSERT INTO servers (name, type) VALUES ('srv-a', 'local')`).run();
  return db;
}

function insertTask(db: Database.Database): number {
  const id = Number(
    db.prepare(
      `INSERT INTO tasks (project_id, title, status, priority, self_review_count, require_plan_approval, source, skip_pr)
       VALUES (1, 'Test task', 'open', 0, 0, 1, 'local', 0)`,
    ).run().lastInsertRowid,
  );
  return id;
}

describe('migration 060: authz_foundation', () => {
  it('creates task_tokens with the expected columns and defaults', () => {
    const db = buildSeededDb();
    const taskId = insertTask(db);
    m060.up(db);

    db.prepare(
      `INSERT INTO task_tokens (task_id, token_hash, window_generation) VALUES (?, ?, ?)`,
    ).run(taskId, 'a'.repeat(64), 1);

    const row = db.prepare('SELECT * FROM task_tokens WHERE task_id = ?').get(taskId) as Record<string, unknown>;
    expect(row.task_id).toBe(taskId);
    expect(row.token_hash).toBe('a'.repeat(64));
    expect(row.window_generation).toBe(1);
    expect(row.issued_at).toBeTruthy();
    expect(row.revoked_at).toBeNull();
    expect(row.revoke_reason).toBeNull();
  });

  it('rejects a duplicate token_hash (unique index)', () => {
    const db = buildSeededDb();
    const taskId = insertTask(db);
    m060.up(db);

    db.prepare(`INSERT INTO task_tokens (task_id, token_hash, window_generation) VALUES (?, ?, ?)`).run(taskId, 'b'.repeat(64), 1);
    expect(() =>
      db.prepare(`INSERT INTO task_tokens (task_id, token_hash, window_generation) VALUES (?, ?, ?)`).run(taskId, 'b'.repeat(64), 2),
    ).toThrow();
  });

  it('does not FK-constrain task_tokens.task_id (rows survive their task row being deleted)', () => {
    const db = buildSeededDb();
    const taskId = insertTask(db);
    m060.up(db);
    db.prepare(`INSERT INTO task_tokens (task_id, token_hash, window_generation) VALUES (?, ?, ?)`).run(taskId, 'c'.repeat(64), 1);

    expect(() => db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)).not.toThrow();
    const row = db.prepare('SELECT * FROM task_tokens WHERE task_id = ?').get(taskId);
    expect(row).toBeTruthy();
  });

  it('creates audit_log with the expected columns', () => {
    const db = buildSeededDb();
    m060.up(db);

    db.prepare(
      `INSERT INTO audit_log (actor_class, actor_id, event, detail) VALUES (?, ?, ?, ?)`,
    ).run('task', 1, 'task_token.issued', JSON.stringify({ taskId: 1 }));

    const row = db.prepare('SELECT * FROM audit_log WHERE event = ?').get('task_token.issued') as Record<string, unknown>;
    expect(row.actor_class).toBe('task');
    expect(row.actor_id).toBe(1);
    expect(row.ts).toBeTruthy();
    expect(JSON.parse(row.detail as string)).toEqual({ taskId: 1 });
  });

  it('allows audit_log.actor_id to be NULL (operator-class events with no single subject)', () => {
    const db = buildSeededDb();
    m060.up(db);

    db.prepare(`INSERT INTO audit_log (actor_class, event) VALUES (?, ?)`).run('operator', 'route_auth.denied');
    const row = db.prepare('SELECT * FROM audit_log WHERE event = ?').get('route_auth.denied') as Record<string, unknown>;
    expect(row.actor_id).toBeNull();
    expect(row.detail).toBeNull();
  });

  it('backfills existing tasks rows with created_by_kind = operator and created_by_id = NULL', () => {
    const db = buildSeededDb();
    const taskId = insertTask(db);
    m060.up(db);

    const row = db.prepare('SELECT created_by_kind, created_by_id FROM tasks WHERE id = ?').get(taskId) as Record<string, unknown>;
    expect(row.created_by_kind).toBe('operator');
    expect(row.created_by_id).toBeNull();
  });

  it('accepts an explicit created_by_kind/created_by_id for a newly-inserted task row', () => {
    const db = buildSeededDb();
    m060.up(db);

    db.prepare(
      `INSERT INTO tasks (project_id, title, status, priority, self_review_count, require_plan_approval, source, skip_pr, created_by_kind, created_by_id)
       VALUES (1, 'Child task', 'open', 0, 0, 1, 'local', 0, 'task', 42)`,
    ).run();
    const row = db.prepare("SELECT created_by_kind, created_by_id FROM tasks WHERE title = 'Child task'").get() as Record<string, unknown>;
    expect(row.created_by_kind).toBe('task');
    expect(row.created_by_id).toBe(42);
  });
});
