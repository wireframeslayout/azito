// Shared fixture for window tests that need the real SQLite schema (full migration chain on an in-memory DB).
import Database from 'better-sqlite3';

// Full migration chain must be replayed against a fresh in-memory DB — same approach as
// SqliteAgentWatchRepository.test.ts (the `windows` table is created in migration 035, the
// `supervised` column added in 050, and dropped again in 056).
import * as m001 from '../../shared/db/migrations/001_initial_schema';
import * as m002 from '../../shared/db/migrations/002_legacy_migrations';
import * as m003 from '../../shared/db/migrations/003_seed_defaults';
import * as m004 from '../../shared/db/migrations/004_project_sidekick_prompt';
import * as m005 from '../../shared/db/migrations/005_model_restructure';
import * as m006 from '../../shared/db/migrations/006_task_orchestrator';
import * as m007 from '../../shared/db/migrations/007_repository_provider';
import * as m008 from '../../shared/db/migrations/008_fix_gitlab_repos';
import * as m009 from '../../shared/db/migrations/009_storage_settings';
import * as m010 from '../../shared/db/migrations/010_plan_approval';
import * as m011 from '../../shared/db/migrations/011_push_subscriptions';
import * as m012 from '../../shared/db/migrations/012_task_git_info';
import * as m013 from '../../shared/db/migrations/013_project_icon_color';
import * as m014 from '../../shared/db/migrations/014_task_worktree';
import * as m015 from '../../shared/db/migrations/015_sidekick_max_concurrency';
import * as m016 from '../../shared/db/migrations/016_structured_prompts';
import * as m017 from '../../shared/db/migrations/017_pending_questions';
import * as m018 from '../../shared/db/migrations/018_questions_json_prompt';
import * as m019 from '../../shared/db/migrations/019_plan_in_implementing_prompt';
import * as m020 from '../../shared/db/migrations/020_project_slug';
import * as m021 from '../../shared/db/migrations/021_agent_servers';
import * as m022 from '../../shared/db/migrations/022_agent_bootstrap';
import * as m023 from '../../shared/db/migrations/023_worker_extra_args';
import * as m024 from '../../shared/db/migrations/024_subagent_config';
import * as m025 from '../../shared/db/migrations/025_inject_prompt_modules';
import * as m026 from '../../shared/db/migrations/026_task_target_branch';
import * as m027 from '../../shared/db/migrations/027_pushing_target_branch';
import * as m028 from '../../shared/db/migrations/028_deduplicate_project_windows';
import * as m029 from '../../shared/db/migrations/029_task_summary';
import * as m030 from '../../shared/db/migrations/030_agent_session_id';
import * as m031 from '../../shared/db/migrations/031_task_skip_pr';
import * as m032 from '../../shared/db/migrations/032_task_working_directory';
import * as m033 from '../../shared/db/migrations/033_pushing_prompt_skip_pr';
import * as m034 from '../../shared/db/migrations/034_task_multi_window';
import * as m035 from '../../shared/db/migrations/035_unified_windows';
import * as m036 from '../../shared/db/migrations/036_remove_sidekick_legacy';
import * as m037 from '../../shared/db/migrations/037_worker_profile_split';
import * as m038 from '../../shared/db/migrations/038_rename_sidekicks_to_operations';
import * as m039 from '../../shared/db/migrations/039_export_edited_phase_prompts';
import * as m040 from '../../shared/db/migrations/040_operation_phase_config';
import * as m041 from '../../shared/db/migrations/041_sidekick_tags';
import * as m042 from '../../shared/db/migrations/042_units';
import * as m043 from '../../shared/db/migrations/043_agent_turns';
import * as m044 from '../../shared/db/migrations/044_agent_watches';
import * as m045 from '../../shared/db/migrations/045_server_mux_runtime';
import * as m046 from '../../shared/db/migrations/046_remove_orchestrator_mode';
import * as m047 from '../../shared/db/migrations/047_task_current_phase';
import * as m048 from '../../shared/db/migrations/048_unit_type_column';
import * as m049 from '../../shared/db/migrations/049_worker_runtime';
import * as m050 from '../../shared/db/migrations/050_window_supervised';
import * as m051 from '../../shared/db/migrations/051_resource_guard_settings';
import * as m052 from '../../shared/db/migrations/052_project_secrets';
import * as m053 from '../../shared/db/migrations/053_browser_tab_snapshots';
import * as m054 from '../../shared/db/migrations/054_ssh_host_fingerprint';
import * as m055 from '../../shared/db/migrations/055_reduce_worker_execution_mode';
import * as m056 from '../../shared/db/migrations/056_drop_windows_supervised';
import * as m057 from '../../shared/db/migrations/057_push_subscription_lang';
import * as m058 from '../../shared/db/migrations/058_disable_ssh_servers';
import * as m059 from '../../shared/db/migrations/059_input_trust_and_exec_gate';
import * as m060 from '../../shared/db/migrations/060_authz_foundation';
import * as m061 from '../../shared/db/migrations/061_isolation_profile';
import * as m062 from '../../shared/db/migrations/062_isolation_report_split';
import * as m063 from '../../shared/db/migrations/063_window_sleep';
import * as m064 from '../../shared/db/migrations/064_distribution_state';
import * as m065 from '../../shared/db/migrations/065_project_server_distribute_code';
import * as m066 from '../../shared/db/migrations/066_project_server_distribution_repository';
import * as m067 from '../../shared/db/migrations/067_task_distribution_repository';
import * as m068 from '../../shared/db/migrations/068_merge_duplicate_window_rows';
import * as m069 from '../../shared/db/migrations/069_window_mux_ref';
import * as m070 from '../../shared/db/migrations/070_supervisor_launch_pane_ref_and_watch_normalize';
import * as m071 from '../../shared/db/migrations/071_agent_watches_window_id';
import * as m072 from '../../shared/db/migrations/072_fix_herdr_mux_ref_kind';
import * as m073 from '../../shared/db/migrations/073_restore_tmux_mux_ref_kind';
import * as m074 from '../../shared/db/migrations/074_herdr_navigation_lock';

interface Migration {
  version: number;
  up: (db: Database.Database) => void;
}

const ALL_MIGRATIONS: Migration[] = [
  m001, m002, m003, m004, m005, m006, m007, m008, m009, m010,
  m011, m012, m013, m014, m015, m016, m017, m018, m019, m020,
  m021, m022, m023, m024, m025, m026, m027, m028, m029, m030,
  m031, m032, m033, m034, m035, m036, m037, m038, m039, m040,
  m041, m042, m043, m044, m045, m046, m047, m048, m049, m050, m051,
  m052, m053, m054, m055, m056, m057, m058, m059, m060, m061, m062,
  m063, m064, m065, m066, m067, m068, m069,
  m070, m071, m072, m073, m074,
];

const MIGRATIONS_REQUIRING_TABLE_REBUILD = new Set([36, 37, 42, 46, 68]);

export function buildSeededDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const migration of ALL_MIGRATIONS) {
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

export function insertProject(db: Database.Database, name: string): number {
  return Number(db.prepare('INSERT INTO projects (name, slug) VALUES (?, ?)').run(name, name).lastInsertRowid);
}

export function insertTask(db: Database.Database, projectId: number, title: string): number {
  return Number(db.prepare('INSERT INTO tasks (project_id, title) VALUES (?, ?)').run(projectId, title).lastInsertRowid);
}
