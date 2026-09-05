import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

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
import * as m061 from './061_isolation_profile';
import * as m062 from './062_isolation_report_split';
import * as m063 from './063_window_sleep';
import * as m064 from './064_distribution_state';
import * as m065 from './065_project_server_distribute_code';
import * as m066 from './066_project_server_distribution_repository';
import * as m067 from './067_task_distribution_repository';
import * as m068 from './068_merge_duplicate_window_rows';
import * as m069 from './069_window_mux_ref';

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
  m051, m052, m053, m054, m055, m056, m057, m058, m059, m060,
  m061, m062, m063, m064, m065, m066, m067, m068,
];

const MIGRATIONS_REQUIRING_TABLE_REBUILD = new Set([36, 37, 42, 46, 68]);

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

function insertWindow(db: Database.Database, overrides: {
  serverName?: string;
  tmuxTarget?: string;
}): number {
  return Number(
    db.prepare(
      `INSERT INTO windows (owner_type, project_id, task_id, server_name, tmux_target, is_primary, window_type, sleeping)
       VALUES ('project', 1, NULL, ?, ?, 0, 'terminal', 0)`,
    ).run(
      overrides.serverName ?? 'srv-a',
      overrides.tmuxTarget ?? 'sess:win',
    ).lastInsertRowid,
  );
}

describe('migration 069: window mux_ref', () => {
  let db: Database.Database;
  beforeEach(() => { db = buildSeededDb(); });

  it('populates mux_ref from tmux_target', () => {
    insertWindow(db, { tmuxTarget: 'main:win--abc' });
    insertWindow(db, { tmuxTarget: 'azito:win--xyz' });

    db.transaction(() => m069.up(db))();

    const rows = db.prepare('SELECT tmux_target, mux_ref FROM windows ORDER BY id').all() as Array<{ tmux_target: string; mux_ref: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].mux_ref).toBe('{"kind":"tmux","workspace":"main","window":"win--abc"}');
    expect(rows[1].mux_ref).toBe('{"kind":"tmux","workspace":"azito","window":"win--xyz"}');
  });

  it('creates unique index on (server_name, mux_ref)', () => {
    insertWindow(db, { tmuxTarget: 'sess:win' });

    db.transaction(() => m069.up(db))();

    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_windows_mux_ref_unique'").get();
    expect(idx).toBeTruthy();
  });

  it('rejects duplicate (server_name, mux_ref) after migration', () => {
    insertWindow(db, { tmuxTarget: 'sess:win' });

    db.transaction(() => m069.up(db))();

    expect(() => {
      db.prepare(
        `INSERT INTO windows (owner_type, project_id, task_id, server_name, tmux_target, is_primary, window_type, sleeping, mux_ref)
         VALUES ('project', 1, NULL, 'srv-a', 'sess:win2', 0, 'terminal', 0, '{"kind":"tmux","workspace":"sess","window":"win"}')`,
      ).run();
    }).toThrow();
  });

  it('preserves existing idx_windows_physical_unique index', () => {
    insertWindow(db, { tmuxTarget: 'sess:win' });

    db.transaction(() => m069.up(db))();

    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_windows_physical_unique'").get();
    expect(idx).toBeTruthy();
  });

  it('handles empty windows table', () => {
    db.transaction(() => m069.up(db))();

    const cols = db.prepare("PRAGMA table_info('windows')").all() as Array<{ name: string }>;
    expect(cols.map(c => c.name)).toContain('mux_ref');
  });
});
