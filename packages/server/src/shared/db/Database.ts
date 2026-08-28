import Database from 'better-sqlite3';
import fs from 'fs';

import * as m001 from './migrations/001_initial_schema';
import * as m002 from './migrations/002_legacy_migrations';
import * as m003 from './migrations/003_seed_defaults';
import * as m004 from './migrations/004_project_sidekick_prompt';
import * as m005 from './migrations/005_model_restructure';
import * as m006 from './migrations/006_task_orchestrator';
import * as m007 from './migrations/007_repository_provider';
import * as m008 from './migrations/008_fix_gitlab_repos';
import * as m009 from './migrations/009_storage_settings';
import * as m010 from './migrations/010_plan_approval';
import * as m011 from './migrations/011_push_subscriptions';
import * as m012 from './migrations/012_task_git_info';
import * as m013 from './migrations/013_project_icon_color';
import * as m014 from './migrations/014_task_worktree';
import * as m015 from './migrations/015_sidekick_max_concurrency';
import * as m016 from './migrations/016_structured_prompts';
import * as m017 from './migrations/017_pending_questions';
import * as m018 from './migrations/018_questions_json_prompt';
import * as m019 from './migrations/019_plan_in_implementing_prompt';
import * as m020 from './migrations/020_project_slug';
import * as m021 from './migrations/021_agent_servers';
import * as m022 from './migrations/022_agent_bootstrap';
import * as m023 from './migrations/023_worker_extra_args';
import * as m024 from './migrations/024_subagent_config';
import * as m025 from './migrations/025_inject_prompt_modules';
import * as m026 from './migrations/026_task_target_branch';
import * as m027 from './migrations/027_pushing_target_branch';
import * as m028 from './migrations/028_deduplicate_project_windows';
import * as m029 from './migrations/029_task_summary';
import * as m030 from './migrations/030_agent_session_id';
import * as m031 from './migrations/031_task_skip_pr';
import * as m032 from './migrations/032_task_working_directory';
import * as m033 from './migrations/033_pushing_prompt_skip_pr';
import * as m034 from './migrations/034_task_multi_window';
import * as m035 from './migrations/035_unified_windows';
import * as m036 from './migrations/036_remove_sidekick_legacy';
import * as m037 from './migrations/037_worker_profile_split';
import * as m038 from './migrations/038_rename_sidekicks_to_operations';
import * as m039 from './migrations/039_export_edited_phase_prompts';
import * as m040 from './migrations/040_operation_phase_config';
import * as m041 from './migrations/041_sidekick_tags';
import * as m042 from './migrations/042_units';
import * as m043 from './migrations/043_agent_turns';
import * as m044 from './migrations/044_agent_watches';
import * as m045 from './migrations/045_server_mux_runtime';
import * as m046 from './migrations/046_remove_orchestrator_mode';
import * as m047 from './migrations/047_task_current_phase';
import * as m048 from './migrations/048_unit_type_column';
import * as m049 from './migrations/049_worker_runtime';
import * as m050 from './migrations/050_window_supervised';
import * as m051 from './migrations/051_resource_guard_settings';
import * as m052 from './migrations/052_project_secrets';
import * as m053 from './migrations/053_browser_tab_snapshots';
import * as m054 from './migrations/054_ssh_host_fingerprint';
import * as m055 from './migrations/055_reduce_worker_execution_mode';
import * as m056 from './migrations/056_drop_windows_supervised';
import * as m057 from './migrations/057_push_subscription_lang';
import * as m058 from './migrations/058_disable_ssh_servers';
import * as m059 from './migrations/059_input_trust_and_exec_gate';
import * as m060 from './migrations/060_authz_foundation';
import * as m061 from './migrations/061_isolation_profile';
import * as m062 from './migrations/062_isolation_report_split';
import * as m063 from './migrations/063_window_sleep';

// ─── Migration runner ───

interface Migration {
  version: number;
  description: string;
  up: (db: import('better-sqlite3').Database) => void;
}

const migrations: Migration[] = [m001, m002, m003, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014, m015, m016, m017, m018, m019, m020, m021, m022, m023, m024, m025, m026, m027, m028, m029, m030, m031, m032, m033, m034, m035, m036, m037, m038, m039, m040, m041, m042, m043, m044, m045, m046, m047, m048, m049, m050, m051, m052, m053, m054, m055, m056, m057, m058, m059, m060, m061, m062, m063];

// Migrations that rebuild a table referenced by other tables' FOREIGN KEY constraints (via
// RENAME + CREATE + copy + DROP) need `foreign_keys` off and `legacy_alter_table` on for the
// duration of the rebuild. Otherwise SQLite either auto-rewrites the referencing tables' FK
// clauses to the temporary table name (leaving a dangling reference once it's dropped) or
// fires the configured ON DELETE action against every row as soon as the original table is
// renamed away. Both pragmas are no-ops if toggled inside an active transaction, so they must
// be set before `db.transaction()` begins.
const MIGRATIONS_REQUIRING_TABLE_REBUILD = new Set([36, 37, 42, 46]);

function runMigrations(db: import('better-sqlite3').Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    (db.prepare('SELECT version FROM _migrations').all() as Array<{ version: number }>)
      .map((r) => r.version),
  );

  const insertMigration = db.prepare('INSERT INTO _migrations (version, description) VALUES (?, ?)');

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    const needsTableRebuild = MIGRATIONS_REQUIRING_TABLE_REBUILD.has(migration.version);
    try {
      if (needsTableRebuild) {
        db.pragma('foreign_keys = OFF');
        db.pragma('legacy_alter_table = ON');
      }
      db.transaction(() => {
        migration.up(db);
        insertMigration.run(migration.version, migration.description);
      })();
      console.log(`Migration ${migration.version}: ${migration.description} ✓`);
    } catch (err) {
      console.error(`Migration ${migration.version} failed:`, err);
      throw err;
    } finally {
      if (needsTableRebuild) {
        db.pragma('legacy_alter_table = OFF');
        db.pragma('foreign_keys = ON');
      }
    }
  }
}

// ─── Exports ───

export type SqliteDatabase = import('better-sqlite3').Database;

export function openDatabase(dbPath: string): SqliteDatabase {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.chmodSync(`${dbPath}${suffix}`, 0o600); } catch {}
  }

  runMigrations(db);
  return db;
}
