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
import * as m070 from './070_supervisor_launch_pane_ref_and_watch_normalize';
import * as m071 from './071_agent_watches_window_id';
import * as m072 from './072_fix_herdr_mux_ref_kind';

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
  m061, m062, m063, m064, m065, m066, m067, m068, m069, m070,
  m071,
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
  return db;
}

function insertServer(db: Database.Database, name: string, muxRuntime: string): void {
  db.prepare(`INSERT INTO servers (name, type, mux_runtime) VALUES (?, 'agent', ?)`).run(name, muxRuntime);
}

function insertWindow(db: Database.Database, serverName: string, tmuxTarget: string, muxRef: string): number {
  return Number(
    db.prepare(
      `INSERT INTO windows (owner_type, project_id, task_id, server_name, tmux_target, mux_ref, is_primary, window_type, sleeping)
       VALUES ('project', 1, NULL, ?, ?, ?, 0, 'terminal', 0)`,
    ).run(serverName, tmuxTarget, muxRef).lastInsertRowid,
  );
}

describe('migration 072: fix herdr/zellij mux_ref kind', () => {
  let db: Database.Database;
  beforeEach(() => { db = buildSeededDb(); });

  it('corrects kind from tmux to herdr for non-tmux-managed windows', () => {
    insertServer(db, 'herdr-srv', 'herdr');
    insertWindow(db, 'herdr-srv', 'azito:herdr-e2e', '{"kind":"tmux","workspace":"azito","window":"herdr-e2e"}');

    db.transaction(() => m072.up(db))();

    const row = db.prepare('SELECT mux_ref FROM windows WHERE server_name = ?').get('herdr-srv') as { mux_ref: string };
    expect(row.mux_ref).toBe('{"kind":"herdr","workspace":"azito","window":"herdr-e2e"}');
  });

  it('corrects kind from tmux to zellij for non-tmux-managed windows', () => {
    insertServer(db, 'zellij-srv', 'zellij');
    insertWindow(db, 'zellij-srv', 'azito:zellij-e2e', '{"kind":"tmux","workspace":"azito","window":"zellij-e2e"}');

    db.transaction(() => m072.up(db))();

    const row = db.prepare('SELECT mux_ref FROM windows WHERE server_name = ?').get('zellij-srv') as { mux_ref: string };
    expect(row.mux_ref).toBe('{"kind":"zellij","workspace":"azito","window":"zellij-e2e"}');
  });

  it('does not modify windows on tmux (system) servers', () => {
    insertServer(db, 'tmux-srv', 'system');
    insertWindow(db, 'tmux-srv', 'azito:tmux-win', '{"kind":"tmux","workspace":"azito","window":"tmux-win"}');

    db.transaction(() => m072.up(db))();

    const row = db.prepare('SELECT mux_ref FROM windows WHERE server_name = ?').get('tmux-srv') as { mux_ref: string };
    expect(row.mux_ref).toBe('{"kind":"tmux","workspace":"azito","window":"tmux-win"}');
  });

  it('skips tmux-managed task windows on herdr server', () => {
    insertServer(db, 'herdr-srv', 'herdr');
    insertWindow(db, 'herdr-srv', 'azito:task-123', '{"kind":"tmux","workspace":"azito","window":"task-123"}');

    db.transaction(() => m072.up(db))();

    const row = db.prepare('SELECT mux_ref FROM windows WHERE server_name = ?').get('herdr-srv') as { mux_ref: string };
    expect(row.mux_ref).toBe('{"kind":"tmux","workspace":"azito","window":"task-123"}');
  });

  it('skips tmux-managed manual windows on herdr server', () => {
    insertServer(db, 'herdr-srv', 'herdr');
    insertWindow(db, 'herdr-srv', 'azito:win--abc4', '{"kind":"tmux","workspace":"azito","window":"win--abc4"}');

    db.transaction(() => m072.up(db))();

    const row = db.prepare('SELECT mux_ref FROM windows WHERE server_name = ?').get('herdr-srv') as { mux_ref: string };
    expect(row.mux_ref).toBe('{"kind":"tmux","workspace":"azito","window":"win--abc4"}');
  });

  it('skips tmux windows with custom baseName (generateWindowName pattern)', () => {
    insertServer(db, 'herdr-srv', 'herdr');
    insertWindow(db, 'herdr-srv', 'azito:editor--ab12', '{"kind":"tmux","workspace":"azito","window":"editor--ab12"}');

    db.transaction(() => m072.up(db))();

    const row = db.prepare('SELECT mux_ref FROM windows WHERE server_name = ?').get('herdr-srv') as { mux_ref: string };
    expect(row.mux_ref).toBe('{"kind":"tmux","workspace":"azito","window":"editor--ab12"}');
  });

  it('converts herdr windows but skips tmux windows on same server', () => {
    insertServer(db, 'herdr-srv', 'herdr');
    const herdrWinId = insertWindow(db, 'herdr-srv', 'azito:herdr-e2e', '{"kind":"tmux","workspace":"azito","window":"herdr-e2e"}');
    const taskWinId = insertWindow(db, 'herdr-srv', 'azito:task-42', '{"kind":"tmux","workspace":"azito","window":"task-42"}');
    const manualWinId = insertWindow(db, 'herdr-srv', 'azito:win--qvp6', '{"kind":"tmux","workspace":"azito","window":"win--qvp6"}');

    db.transaction(() => m072.up(db))();

    const herdrRow = db.prepare('SELECT mux_ref FROM windows WHERE id = ?').get(herdrWinId) as { mux_ref: string };
    const taskRow = db.prepare('SELECT mux_ref FROM windows WHERE id = ?').get(taskWinId) as { mux_ref: string };
    const manualRow = db.prepare('SELECT mux_ref FROM windows WHERE id = ?').get(manualWinId) as { mux_ref: string };

    expect(herdrRow.mux_ref).toBe('{"kind":"herdr","workspace":"azito","window":"herdr-e2e"}');
    expect(taskRow.mux_ref).toBe('{"kind":"tmux","workspace":"azito","window":"task-42"}');
    expect(manualRow.mux_ref).toBe('{"kind":"tmux","workspace":"azito","window":"win--qvp6"}');
  });

  it('is idempotent — already correct kind is unchanged', () => {
    insertServer(db, 'herdr-srv', 'herdr');
    insertWindow(db, 'herdr-srv', 'azito:correct', '{"kind":"herdr","workspace":"azito","window":"correct"}');

    db.transaction(() => m072.up(db))();

    const row = db.prepare('SELECT mux_ref FROM windows WHERE server_name = ?').get('herdr-srv') as { mux_ref: string };
    expect(row.mux_ref).toBe('{"kind":"herdr","workspace":"azito","window":"correct"}');
  });

  it('handles empty windows table', () => {
    insertServer(db, 'herdr-srv', 'herdr');

    expect(() => db.transaction(() => m072.up(db))()).not.toThrow();
  });
});
