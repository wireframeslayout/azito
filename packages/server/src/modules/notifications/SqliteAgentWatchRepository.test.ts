import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

// Full migration chain must be replayed against a fresh in-memory DB — same
// approach as SqliteAgentTurnRepository.test.ts (agent_watches depends on
// tables created through migration 043).
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

import { SqliteAgentWatchRepository } from './SqliteAgentWatchRepository';
import type { SqliteDatabase } from '../../shared/db/Database';

interface Migration {
  version: number;
  up: (db: Database.Database) => void;
}

const ALL_MIGRATIONS: Migration[] = [
  m001, m002, m003, m004, m005, m006, m007, m008, m009, m010,
  m011, m012, m013, m014, m015, m016, m017, m018, m019, m020,
  m021, m022, m023, m024, m025, m026, m027, m028, m029, m030,
  m031, m032, m033, m034, m035, m036, m037, m038, m039, m040, m041, m042, m043, m044,
];

const MIGRATIONS_REQUIRING_TABLE_REBUILD = new Set([36, 37, 42]);

function buildSeededDb(): Database.Database {
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

describe('SqliteAgentWatchRepository', () => {
  let db: Database.Database;
  let repo: SqliteAgentWatchRepository;

  beforeEach(() => {
    db = buildSeededDb();
    repo = new SqliteAgentWatchRepository(db as unknown as SqliteDatabase);
  });

  it('adds a watch and finds it by server/target key', () => {
    repo.add('https://push.example/ep1', 'local', 'session:0', 'My Window');

    const found = repo.findByKey('local', 'session:0');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      endpoint: 'https://push.example/ep1',
      serverName: 'local',
      target: 'session:0',
      label: 'My Window',
    });
  });

  it('upserts on repeated add for the same (endpoint, server, target), updating the label', () => {
    repo.add('https://push.example/ep1', 'local', 'session:0', 'Old Label');
    repo.add('https://push.example/ep1', 'local', 'session:0', 'New Label');

    const found = repo.findByKey('local', 'session:0');
    expect(found).toHaveLength(1);
    expect(found[0].label).toBe('New Label');
  });

  it('finds all watches for a given endpoint across targets', () => {
    repo.add('https://push.example/ep1', 'local', 'session:0', null);
    repo.add('https://push.example/ep1', 'local', 'session:1', null);
    repo.add('https://push.example/ep2', 'local', 'session:0', null);

    const found = repo.findByEndpoint('https://push.example/ep1');
    expect(found).toHaveLength(2);
    expect(found.map((w) => w.target).sort()).toEqual(['session:0', 'session:1']);
  });

  it('removes a watch by (endpoint, server, target) key', () => {
    repo.add('https://push.example/ep1', 'local', 'session:0', null);
    repo.removeByKey('https://push.example/ep1', 'local', 'session:0');

    expect(repo.findByKey('local', 'session:0')).toHaveLength(0);
  });

  it('deletes a watch by id (one-shot consumption)', () => {
    repo.add('https://push.example/ep1', 'local', 'session:0', null);
    const [watch] = repo.findByKey('local', 'session:0');

    repo.deleteById(watch.id);

    expect(repo.findByKey('local', 'session:0')).toHaveLength(0);
  });

  it('returns an empty array when no watch matches the key', () => {
    expect(repo.findByKey('nonexistent', 'session:0')).toEqual([]);
  });
});
