import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

// Migrations 001->064 must be replayed against a fresh in-memory DB before 065 can run.
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
  m061, m062, m063, m064, m065,
];

// Same table-rebuild toggle as the real migration runner in Database.ts.
const MIGRATIONS_REQUIRING_TABLE_REBUILD = new Set([36, 37, 42, 46]);
// 066 (this migration under test) also rebuilds project_servers — handled
// explicitly by the m066.up(db) call sites below (foreign_keys OFF/ON +
// legacy_alter_table), not through buildSeededDb()'s PRIOR_MIGRATIONS loop.

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
  db.prepare(`INSERT INTO servers (name, type) VALUES ('srv-local', 'local')`).run();
  db.prepare(`INSERT INTO servers (name, type) VALUES ('srv-agent', 'agent')`).run();
  return db;
}

function runM066(db: Database.Database): void {
  db.pragma('foreign_keys = OFF');
  db.pragma('legacy_alter_table = ON');
  db.transaction(() => m066.up(db))();
  db.pragma('legacy_alter_table = OFF');
  db.pragma('foreign_keys = ON');
}

describe('migration 066: project_server_distribution_repository', () => {
  it('adds distribution_repository_id defaulting to NULL for existing rows', () => {
    const db = buildSeededDb();
    db.prepare(`INSERT INTO project_servers (project_id, server_name, tmux_session) VALUES (1, 'srv-agent', 'azito')`).run();

    runM066(db);

    const row = db.prepare(`SELECT distribution_repository_id FROM project_servers WHERE project_id = 1 AND server_name = 'srv-agent'`).get() as { distribution_repository_id: number | null };
    expect(row.distribution_repository_id).toBeNull();
  });

  it('backfills distribution_repository_id from the project\'s single repository when distribute_code is on', () => {
    const db = buildSeededDb();
    const repoId = db.prepare(`INSERT INTO project_repositories (project_id, url, provider) VALUES (1, 'https://github.com/acme/widget.git', 'github')`).run().lastInsertRowid as number;
    db.prepare(`INSERT INTO project_servers (project_id, server_name, tmux_session, distribute_code) VALUES (1, 'srv-agent', 'azito', 1)`).run();

    runM066(db);

    const row = db.prepare(`SELECT distribution_repository_id FROM project_servers WHERE project_id = 1 AND server_name = 'srv-agent'`).get() as { distribution_repository_id: number | null };
    expect(row.distribution_repository_id).toBe(repoId);
  });

  it('leaves distribution_repository_id NULL when distribute_code is on but the project has multiple repositories', () => {
    const db = buildSeededDb();
    db.prepare(`INSERT INTO project_repositories (project_id, url, provider) VALUES (1, 'https://github.com/acme/widget.git', 'github')`).run();
    db.prepare(`INSERT INTO project_repositories (project_id, url, provider) VALUES (1, 'https://github.com/acme/other.git', 'github')`).run();
    db.prepare(`INSERT INTO project_servers (project_id, server_name, tmux_session, distribute_code) VALUES (1, 'srv-agent', 'azito', 1)`).run();

    runM066(db);

    const row = db.prepare(`SELECT distribution_repository_id FROM project_servers WHERE project_id = 1 AND server_name = 'srv-agent'`).get() as { distribution_repository_id: number | null };
    expect(row.distribution_repository_id).toBeNull();
  });

  it('leaves distribution_repository_id NULL when distribute_code is on but the project has zero repositories', () => {
    const db = buildSeededDb();
    db.prepare(`INSERT INTO project_servers (project_id, server_name, tmux_session, distribute_code) VALUES (1, 'srv-agent', 'azito', 1)`).run();

    runM066(db);

    const row = db.prepare(`SELECT distribution_repository_id FROM project_servers WHERE project_id = 1 AND server_name = 'srv-agent'`).get() as { distribution_repository_id: number | null };
    expect(row.distribution_repository_id).toBeNull();
  });

  it('does not backfill distribution_repository_id when distribute_code is off, even with a single repository', () => {
    const db = buildSeededDb();
    db.prepare(`INSERT INTO project_repositories (project_id, url, provider) VALUES (1, 'https://github.com/acme/widget.git', 'github')`).run();
    db.prepare(`INSERT INTO project_servers (project_id, server_name, tmux_session, distribute_code) VALUES (1, 'srv-agent', 'azito', 0)`).run();

    runM066(db);

    const row = db.prepare(`SELECT distribution_repository_id FROM project_servers WHERE project_id = 1 AND server_name = 'srv-agent'`).get() as { distribution_repository_id: number | null };
    expect(row.distribution_repository_id).toBeNull();
  });

  it('SET NULLs distribution_repository_id when the referenced repository is deleted', () => {
    const db = buildSeededDb();
    const repoId = db.prepare(`INSERT INTO project_repositories (project_id, url, provider) VALUES (1, 'https://github.com/acme/widget.git', 'github')`).run().lastInsertRowid as number;
    db.prepare(`INSERT INTO project_servers (project_id, server_name, tmux_session, distribute_code) VALUES (1, 'srv-agent', 'azito', 1)`).run();

    runM066(db);

    let row = db.prepare(`SELECT distribution_repository_id FROM project_servers WHERE project_id = 1 AND server_name = 'srv-agent'`).get() as { distribution_repository_id: number | null };
    expect(row.distribution_repository_id).toBe(repoId);

    db.prepare(`DELETE FROM project_repositories WHERE id = ?`).run(repoId);

    row = db.prepare(`SELECT distribution_repository_id FROM project_servers WHERE project_id = 1 AND server_name = 'srv-agent'`).get() as { distribution_repository_id: number | null };
    expect(row.distribution_repository_id).toBeNull();
  });

  it('backfills distribution_repository_id for an isolated server even when distribute_code is off', () => {
    const db = buildSeededDb();
    db.prepare(`UPDATE servers SET isolation_intent = 1 WHERE name = 'srv-agent'`).run();
    const repoId = db.prepare(`INSERT INTO project_repositories (project_id, url, provider) VALUES (1, 'https://github.com/acme/widget.git', 'github')`).run().lastInsertRowid as number;
    db.prepare(`INSERT INTO project_servers (project_id, server_name, tmux_session, distribute_code) VALUES (1, 'srv-agent', 'azito', 0)`).run();

    runM066(db);

    const row = db.prepare(`SELECT distribution_repository_id FROM project_servers WHERE project_id = 1 AND server_name = 'srv-agent'`).get() as { distribution_repository_id: number | null };
    expect(row.distribution_repository_id).toBe(repoId);
  });

  it('leaves distribution_repository_id NULL for a non-isolated server when distribute_code is off', () => {
    const db = buildSeededDb();
    db.prepare(`INSERT INTO project_repositories (project_id, url, provider) VALUES (1, 'https://github.com/acme/widget.git', 'github')`).run();
    db.prepare(`INSERT INTO project_servers (project_id, server_name, tmux_session, distribute_code) VALUES (1, 'srv-agent', 'azito', 0)`).run();

    runM066(db);

    const row = db.prepare(`SELECT distribution_repository_id FROM project_servers WHERE project_id = 1 AND server_name = 'srv-agent'`).get() as { distribution_repository_id: number | null };
    expect(row.distribution_repository_id).toBeNull();
  });

  it('leaves distribution_repository_id NULL for an isolated server when the project has multiple repositories', () => {
    const db = buildSeededDb();
    db.prepare(`UPDATE servers SET isolation_intent = 1 WHERE name = 'srv-agent'`).run();
    db.prepare(`INSERT INTO project_repositories (project_id, url, provider) VALUES (1, 'https://github.com/acme/widget.git', 'github')`).run();
    db.prepare(`INSERT INTO project_repositories (project_id, url, provider) VALUES (1, 'https://github.com/acme/other.git', 'github')`).run();
    db.prepare(`INSERT INTO project_servers (project_id, server_name, tmux_session, distribute_code) VALUES (1, 'srv-agent', 'azito', 0)`).run();

    runM066(db);

    const row = db.prepare(`SELECT distribution_repository_id FROM project_servers WHERE project_id = 1 AND server_name = 'srv-agent'`).get() as { distribution_repository_id: number | null };
    expect(row.distribution_repository_id).toBeNull();
  });

  it('accepts an explicitly-set distribution_repository_id pointing at any of the project\'s repositories after the migration runs', () => {
    const db = buildSeededDb();
    db.prepare(`INSERT INTO project_repositories (project_id, url, provider) VALUES (1, 'https://github.com/acme/widget.git', 'github')`).run();
    const repoId2 = db.prepare(`INSERT INTO project_repositories (project_id, url, provider) VALUES (1, 'https://github.com/acme/other.git', 'github')`).run().lastInsertRowid as number;
    db.prepare(`INSERT INTO project_servers (project_id, server_name, tmux_session, distribute_code) VALUES (1, 'srv-agent', 'azito', 1)`).run();
    runM066(db);

    db.prepare(`UPDATE project_servers SET distribution_repository_id = ? WHERE project_id = 1 AND server_name = 'srv-agent'`).run(repoId2);

    const row = db.prepare(`SELECT distribution_repository_id FROM project_servers WHERE project_id = 1 AND server_name = 'srv-agent'`).get() as { distribution_repository_id: number | null };
    expect(row.distribution_repository_id).toBe(repoId2);
  });
});
