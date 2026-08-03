import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

// Migrations 001→043 must be replayed against a fresh in-memory DB before 044 can run.
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

interface Migration {
  version: number;
  up: (db: Database.Database) => void;
}

const PRIOR_MIGRATIONS: Migration[] = [
  m001, m002, m003, m004, m005, m006, m007, m008, m009, m010,
  m011, m012, m013, m014, m015, m016, m017, m018, m019, m020,
  m021, m022, m023, m024, m025, m026, m027, m028, m029, m030,
  m031, m032, m033, m034, m035, m036, m037, m038, m039, m040, m041, m042, m043,
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

describe('migration 044: agent_watches', () => {
  it('creates the agent_watches table with expected columns and defaults', () => {
    const db = buildSeededDb();
    m044.up(db);

    const columns = (db.prepare("PRAGMA table_info('agent_watches')").all() as Array<{ name: string; notnull: number; dflt_value: string | null }>);
    const byName = new Map(columns.map((c) => [c.name, c]));

    expect(byName.has('id')).toBe(true);
    expect(byName.get('endpoint')?.notnull).toBe(1);
    expect(byName.get('server_name')?.notnull).toBe(1);
    expect(byName.get('target')?.notnull).toBe(1);
    expect(byName.has('label')).toBe(true);
    expect(byName.get('created_at')?.notnull).toBe(1);
  });

  it('inserts a row and reads it back with defaults applied', () => {
    const db = buildSeededDb();
    m044.up(db);

    const id = Number(
      db.prepare('INSERT INTO agent_watches (endpoint, server_name, target) VALUES (?, ?, ?)')
        .run('https://push.example/ep1', 'local', 'session:0').lastInsertRowid,
    );

    const row = db.prepare('SELECT * FROM agent_watches WHERE id = ?').get(id) as Record<string, unknown>;
    expect(row.endpoint).toBe('https://push.example/ep1');
    expect(row.server_name).toBe('local');
    expect(row.target).toBe('session:0');
    expect(row.label).toBeNull();
    expect(row.created_at).toBeTruthy();
  });

  it('enforces uniqueness on (endpoint, server_name, target)', () => {
    const db = buildSeededDb();
    m044.up(db);

    db.prepare('INSERT INTO agent_watches (endpoint, server_name, target) VALUES (?, ?, ?)')
      .run('https://push.example/ep1', 'local', 'session:0');

    expect(() => {
      db.prepare('INSERT INTO agent_watches (endpoint, server_name, target) VALUES (?, ?, ?)')
        .run('https://push.example/ep1', 'local', 'session:0');
    }).toThrow();
  });

  it('allows the same endpoint to watch different targets', () => {
    const db = buildSeededDb();
    m044.up(db);

    db.prepare('INSERT INTO agent_watches (endpoint, server_name, target) VALUES (?, ?, ?)')
      .run('https://push.example/ep1', 'local', 'session:0');
    db.prepare('INSERT INTO agent_watches (endpoint, server_name, target) VALUES (?, ?, ?)')
      .run('https://push.example/ep1', 'local', 'session:1');

    const count = (db.prepare('SELECT COUNT(*) as c FROM agent_watches').get() as { c: number }).c;
    expect(count).toBe(2);
  });
});
