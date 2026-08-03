import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

// Migrations 001→042 must be replayed against a fresh in-memory DB before 043 can run
// (043 adds a column to units, created by 042).
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

interface Migration {
  version: number;
  up: (db: Database.Database) => void;
}

const PRIOR_MIGRATIONS: Migration[] = [
  m001, m002, m003, m004, m005, m006, m007, m008, m009, m010,
  m011, m012, m013, m014, m015, m016, m017, m018, m019, m020,
  m021, m022, m023, m024, m025, m026, m027, m028, m029, m030,
  m031, m032, m033, m034, m035, m036, m037, m038, m039, m040, m041, m042,
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

function insertProject(db: Database.Database, name: string): number {
  return Number(db.prepare('INSERT INTO projects (name, slug) VALUES (?, ?)').run(name, name).lastInsertRowid);
}

function insertTask(db: Database.Database, projectId: number, title: string): number {
  return Number(db.prepare('INSERT INTO tasks (project_id, title) VALUES (?, ?)').run(projectId, title).lastInsertRowid);
}

function insertUnit(db: Database.Database, name: string): number {
  return Number(db.prepare('INSERT INTO units (name) VALUES (?)').run(name).lastInsertRowid);
}

describe('migration 043: agent_turns / agent_turn_events / units.worker_execution_mode', () => {
  it('creates the agent_turns table with expected columns and defaults', () => {
    const db = buildSeededDb();
    m043.up(db);

    const columns = (db.prepare("PRAGMA table_info('agent_turns')").all() as Array<{ name: string; notnull: number; dflt_value: string | null }>);
    const byName = new Map(columns.map((c) => [c.name, c]));

    expect(byName.has('id')).toBe(true);
    expect(byName.get('task_id')?.notnull).toBe(1);
    expect(byName.has('unit_id')).toBe(true);
    expect(byName.get('kind')?.notnull).toBe(1);
    expect(byName.has('phase')).toBe(true);
    expect(byName.get('nonce')?.notnull).toBe(1);
    expect(byName.get('status')?.notnull).toBe(1);
    expect(byName.get('status')?.dflt_value).toBe("'running'");
    expect(byName.has('completion_source')).toBe(true);
    expect(byName.has('confidence')).toBe(true);
    expect(byName.has('server_name')).toBe(true);
    expect(byName.has('tmux_target')).toBe(true);
    expect(byName.has('output_file_path')).toBe(true);
    expect(byName.get('started_at')?.notnull).toBe(1);
    expect(byName.has('ended_at')).toBe(true);
  });

  it('creates the agent_turn_events table with expected columns and defaults', () => {
    const db = buildSeededDb();
    m043.up(db);

    const columns = (db.prepare("PRAGMA table_info('agent_turn_events')").all() as Array<{ name: string; notnull: number; dflt_value: string | null }>);
    const byName = new Map(columns.map((c) => [c.name, c]));

    expect(byName.get('turn_id')?.notnull).toBe(1);
    expect(byName.get('type')?.notnull).toBe(1);
    expect(byName.has('payload')).toBe(true);
    expect(byName.get('source')?.notnull).toBe(1);
    expect(byName.get('source')?.dflt_value).toBe("'http'");
    expect(byName.get('created_at')?.notnull).toBe(1);
  });

  it('creates idx_agent_turns_task and idx_agent_turn_events_turn indexes', () => {
    const db = buildSeededDb();
    m043.up(db);

    const indexNames = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((r) => r.name);
    expect(indexNames).toContain('idx_agent_turns_task');
    expect(indexNames).toContain('idx_agent_turn_events_turn');
  });

  it('adds units.worker_execution_mode defaulting to tmux-pipe', () => {
    const db = buildSeededDb();
    const unitId = insertUnit(db, 'unit-a');

    m043.up(db);

    const unit = db.prepare('SELECT worker_execution_mode FROM units WHERE id = ?').get(unitId) as { worker_execution_mode: string };
    expect(unit.worker_execution_mode).toBe('tmux-pipe');
  });

  it('inserts an agent_turns row and reads it back with defaults applied', () => {
    const db = buildSeededDb();
    const projectId = insertProject(db, 'proj-a');
    const taskId = insertTask(db, projectId, 'task-a');
    m043.up(db);

    const turnId = Number(
      db.prepare('INSERT INTO agent_turns (task_id, kind, nonce) VALUES (?, ?, ?)').run(taskId, 'phase', 'nonce-1').lastInsertRowid,
    );

    const turn = db.prepare('SELECT * FROM agent_turns WHERE id = ?').get(turnId) as Record<string, unknown>;
    expect(turn.task_id).toBe(taskId);
    expect(turn.status).toBe('running');
    expect(turn.ended_at).toBeNull();
  });

  it('cascades agent_turn_events deletion when the parent turn is deleted', () => {
    const db = buildSeededDb();
    const projectId = insertProject(db, 'proj-b');
    const taskId = insertTask(db, projectId, 'task-b');
    m043.up(db);

    const turnId = Number(
      db.prepare('INSERT INTO agent_turns (task_id, kind, nonce) VALUES (?, ?, ?)').run(taskId, 'phase', 'nonce-2').lastInsertRowid,
    );
    db.prepare('INSERT INTO agent_turn_events (turn_id, type) VALUES (?, ?)').run(turnId, 'progress');

    db.prepare('DELETE FROM agent_turns WHERE id = ?').run(turnId);

    const events = db.prepare('SELECT * FROM agent_turn_events WHERE turn_id = ?').all(turnId);
    expect(events).toHaveLength(0);
  });

  it('cascades agent_turns deletion when the parent task is deleted', () => {
    const db = buildSeededDb();
    const projectId = insertProject(db, 'proj-c');
    const taskId = insertTask(db, projectId, 'task-c');
    m043.up(db);

    const turnId = Number(
      db.prepare('INSERT INTO agent_turns (task_id, kind, nonce) VALUES (?, ?, ?)').run(taskId, 'phase', 'nonce-3').lastInsertRowid,
    );

    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);

    const turn = db.prepare('SELECT * FROM agent_turns WHERE id = ?').get(turnId);
    expect(turn).toBeUndefined();
  });

  it('sets agent_turns.unit_id to NULL when the referenced unit is deleted', () => {
    const db = buildSeededDb();
    const projectId = insertProject(db, 'proj-d');
    const taskId = insertTask(db, projectId, 'task-d');
    const unitId = insertUnit(db, 'unit-d');
    m043.up(db);

    const turnId = Number(
      db.prepare('INSERT INTO agent_turns (task_id, unit_id, kind, nonce) VALUES (?, ?, ?, ?)').run(taskId, unitId, 'phase', 'nonce-4').lastInsertRowid,
    );

    db.prepare('DELETE FROM units WHERE id = ?').run(unitId);

    const turn = db.prepare('SELECT unit_id FROM agent_turns WHERE id = ?').get(turnId) as { unit_id: number | null };
    expect(turn.unit_id).toBeNull();
  });
});
