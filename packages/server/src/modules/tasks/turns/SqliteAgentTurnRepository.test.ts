import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

// Full migration chain must be replayed against a fresh in-memory DB — same
// approach as 043_agent_turns.test.ts (agent_turns depends on tables created
// through migration 042).
import * as m001 from '../../../shared/db/migrations/001_initial_schema';
import * as m002 from '../../../shared/db/migrations/002_legacy_migrations';
import * as m003 from '../../../shared/db/migrations/003_seed_defaults';
import * as m004 from '../../../shared/db/migrations/004_project_sidekick_prompt';
import * as m005 from '../../../shared/db/migrations/005_model_restructure';
import * as m006 from '../../../shared/db/migrations/006_task_orchestrator';
import * as m007 from '../../../shared/db/migrations/007_repository_provider';
import * as m008 from '../../../shared/db/migrations/008_fix_gitlab_repos';
import * as m009 from '../../../shared/db/migrations/009_storage_settings';
import * as m010 from '../../../shared/db/migrations/010_plan_approval';
import * as m011 from '../../../shared/db/migrations/011_push_subscriptions';
import * as m012 from '../../../shared/db/migrations/012_task_git_info';
import * as m013 from '../../../shared/db/migrations/013_project_icon_color';
import * as m014 from '../../../shared/db/migrations/014_task_worktree';
import * as m015 from '../../../shared/db/migrations/015_sidekick_max_concurrency';
import * as m016 from '../../../shared/db/migrations/016_structured_prompts';
import * as m017 from '../../../shared/db/migrations/017_pending_questions';
import * as m018 from '../../../shared/db/migrations/018_questions_json_prompt';
import * as m019 from '../../../shared/db/migrations/019_plan_in_implementing_prompt';
import * as m020 from '../../../shared/db/migrations/020_project_slug';
import * as m021 from '../../../shared/db/migrations/021_agent_servers';
import * as m022 from '../../../shared/db/migrations/022_agent_bootstrap';
import * as m023 from '../../../shared/db/migrations/023_worker_extra_args';
import * as m024 from '../../../shared/db/migrations/024_subagent_config';
import * as m025 from '../../../shared/db/migrations/025_inject_prompt_modules';
import * as m026 from '../../../shared/db/migrations/026_task_target_branch';
import * as m027 from '../../../shared/db/migrations/027_pushing_target_branch';
import * as m028 from '../../../shared/db/migrations/028_deduplicate_project_windows';
import * as m029 from '../../../shared/db/migrations/029_task_summary';
import * as m030 from '../../../shared/db/migrations/030_agent_session_id';
import * as m031 from '../../../shared/db/migrations/031_task_skip_pr';
import * as m032 from '../../../shared/db/migrations/032_task_working_directory';
import * as m033 from '../../../shared/db/migrations/033_pushing_prompt_skip_pr';
import * as m034 from '../../../shared/db/migrations/034_task_multi_window';
import * as m035 from '../../../shared/db/migrations/035_unified_windows';
import * as m036 from '../../../shared/db/migrations/036_remove_sidekick_legacy';
import * as m037 from '../../../shared/db/migrations/037_worker_profile_split';
import * as m038 from '../../../shared/db/migrations/038_rename_sidekicks_to_operations';
import * as m039 from '../../../shared/db/migrations/039_export_edited_phase_prompts';
import * as m040 from '../../../shared/db/migrations/040_operation_phase_config';
import * as m041 from '../../../shared/db/migrations/041_sidekick_tags';
import * as m042 from '../../../shared/db/migrations/042_units';
import * as m043 from '../../../shared/db/migrations/043_agent_turns';

import { SqliteAgentTurnRepository } from './SqliteAgentTurnRepository';
import type { SqliteDatabase } from '../../../shared/db/Database';

interface Migration {
  version: number;
  up: (db: Database.Database) => void;
}

const ALL_MIGRATIONS: Migration[] = [
  m001, m002, m003, m004, m005, m006, m007, m008, m009, m010,
  m011, m012, m013, m014, m015, m016, m017, m018, m019, m020,
  m021, m022, m023, m024, m025, m026, m027, m028, m029, m030,
  m031, m032, m033, m034, m035, m036, m037, m038, m039, m040, m041, m042, m043,
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

function insertProject(db: Database.Database, name: string): number {
  return Number(db.prepare('INSERT INTO projects (name, slug) VALUES (?, ?)').run(name, name).lastInsertRowid);
}

function insertTask(db: Database.Database, projectId: number, title: string): number {
  return Number(db.prepare('INSERT INTO tasks (project_id, title) VALUES (?, ?)').run(projectId, title).lastInsertRowid);
}

function insertUnit(db: Database.Database, name: string): number {
  return Number(db.prepare('INSERT INTO units (name) VALUES (?)').run(name).lastInsertRowid);
}

describe('SqliteAgentTurnRepository', () => {
  let db: Database.Database;
  let repo: SqliteAgentTurnRepository;
  let projectId: number;
  let taskId: number;

  beforeEach(() => {
    db = buildSeededDb();
    repo = new SqliteAgentTurnRepository(db as unknown as SqliteDatabase);
    projectId = insertProject(db, 'proj');
    taskId = insertTask(db, projectId, 'task');
  });

  describe('create / findById', () => {
    it('creates a turn with defaults and reads it back', () => {
      const turn = repo.create({ taskId, kind: 'phase', phase: 'implementing', nonce: 'abc123' });

      expect(turn.id).toBeGreaterThan(0);
      expect(turn.taskId).toBe(taskId);
      expect(turn.unitId).toBeNull();
      expect(turn.kind).toBe('phase');
      expect(turn.phase).toBe('implementing');
      expect(turn.nonce).toBe('abc123');
      expect(turn.status).toBe('running');
      expect(turn.completionSource).toBeNull();
      expect(turn.confidence).toBeNull();
      expect(turn.endedAt).toBeNull();

      const found = repo.findById(turn.id);
      expect(found).toEqual(turn);
    });

    it('persists optional fields when provided', () => {
      const unitId = insertUnit(db, 'unit-a');
      const turn = repo.create({
        taskId,
        unitId,
        kind: 'follow_up',
        phase: null,
        nonce: 'n1',
        serverName: 'local',
        tmuxTarget: 'azito:1.0',
        outputFilePath: '/tmp/out.log',
      });

      expect(turn.unitId).toBe(unitId);
      expect(turn.kind).toBe('follow_up');
      expect(turn.phase).toBeNull();
      expect(turn.serverName).toBe('local');
      expect(turn.tmuxTarget).toBe('azito:1.0');
      expect(turn.outputFilePath).toBe('/tmp/out.log');
    });

    it('returns null for a non-existent id', () => {
      expect(repo.findById(999999)).toBeNull();
    });
  });

  describe('findLatestByTaskPhase / findLatestByTask', () => {
    it('returns the most recently created turn for a task+phase', () => {
      repo.create({ taskId, kind: 'phase', phase: 'implementing', nonce: 'n1' });
      const second = repo.create({ taskId, kind: 'phase', phase: 'implementing', nonce: 'n2' });
      repo.create({ taskId, kind: 'phase', phase: 'reviewing', nonce: 'n3' });

      const latest = repo.findLatestByTaskPhase(taskId, 'implementing');
      expect(latest?.id).toBe(second.id);
    });

    it('returns null when no turn matches the task+phase', () => {
      expect(repo.findLatestByTaskPhase(taskId, 'pushing')).toBeNull();
    });

    it('returns the most recently created turn for a task regardless of phase', () => {
      repo.create({ taskId, kind: 'phase', phase: 'implementing', nonce: 'n1' });
      const last = repo.create({ taskId, kind: 'phase', phase: 'reviewing', nonce: 'n2' });

      expect(repo.findLatestByTask(taskId)?.id).toBe(last.id);
    });

    it('returns null when the task has no turns', () => {
      const otherTaskId = insertTask(db, projectId, 'other');
      expect(repo.findLatestByTask(otherTaskId)).toBeNull();
    });
  });

  describe('findRunningByTask', () => {
    it('returns the most recently created running turn for the task', () => {
      repo.create({ taskId, kind: 'phase', phase: 'implementing', nonce: 'n1' });
      const second = repo.create({ taskId, kind: 'phase', phase: 'implementing', nonce: 'n2' });

      expect(repo.findRunningByTask(taskId)?.id).toBe(second.id);
    });

    it('returns null when the task has no turns', () => {
      const otherTaskId = insertTask(db, projectId, 'other');
      expect(repo.findRunningByTask(otherTaskId)).toBeNull();
    });

    it('returns null once the only turn has ended', () => {
      const turn = repo.create({ taskId, kind: 'phase', phase: 'implementing', nonce: 'n1' });
      repo.markEnded(turn.id, { status: 'completed', completionSource: 'azitoctl', confidence: 'explicit' });

      expect(repo.findRunningByTask(taskId)).toBeNull();
    });

    it('ignores superseded turns and returns the still-running one', () => {
      const superseded = repo.create({ taskId, kind: 'phase', phase: 'implementing', nonce: 'n1' });
      const running = repo.create({ taskId, kind: 'phase', phase: 'implementing', nonce: 'n2' });
      repo.supersedeRunning(taskId, running.id);

      expect(repo.findById(superseded.id)?.status).toBe('superseded');
      expect(repo.findRunningByTask(taskId)?.id).toBe(running.id);
    });
  });

  describe('markEnded', () => {
    it('updates status, completionSource, confidence, and endedAt', () => {
      const turn = repo.create({ taskId, kind: 'phase', phase: 'implementing', nonce: 'n1' });

      repo.markEnded(turn.id, { status: 'completed', completionSource: 'azitoctl', confidence: 'explicit' });

      const updated = repo.findById(turn.id);
      expect(updated?.status).toBe('completed');
      expect(updated?.completionSource).toBe('azitoctl');
      expect(updated?.confidence).toBe('explicit');
      expect(updated?.endedAt).not.toBeNull();
    });

    it('accepts an explicit endedAt timestamp', () => {
      const turn = repo.create({ taskId, kind: 'phase', phase: 'implementing', nonce: 'n1' });

      repo.markEnded(turn.id, {
        status: 'failed',
        completionSource: 'timeout',
        confidence: 'low',
        endedAt: '2026-01-01T00:00:00.000Z',
      });

      const updated = repo.findById(turn.id);
      expect(updated?.endedAt).toBe('2026-01-01T00:00:00.000Z');
      expect(updated?.status).toBe('failed');
    });
  });

  describe('supersedeRunning', () => {
    it('marks all running turns for a task as superseded', () => {
      const a = repo.create({ taskId, kind: 'phase', phase: 'implementing', nonce: 'n1' });
      const b = repo.create({ taskId, kind: 'phase', phase: 'implementing', nonce: 'n2' });

      repo.supersedeRunning(taskId);

      expect(repo.findById(a.id)?.status).toBe('superseded');
      expect(repo.findById(b.id)?.status).toBe('superseded');
    });

    it('excludes the given turn id when provided', () => {
      const a = repo.create({ taskId, kind: 'phase', phase: 'implementing', nonce: 'n1' });
      const b = repo.create({ taskId, kind: 'phase', phase: 'implementing', nonce: 'n2' });

      repo.supersedeRunning(taskId, b.id);

      expect(repo.findById(a.id)?.status).toBe('superseded');
      expect(repo.findById(b.id)?.status).toBe('running');
    });

    it('does not affect turns already in a terminal state', () => {
      const a = repo.create({ taskId, kind: 'phase', phase: 'implementing', nonce: 'n1' });
      repo.markEnded(a.id, { status: 'completed', completionSource: 'azitoctl', confidence: 'explicit' });

      repo.supersedeRunning(taskId);

      expect(repo.findById(a.id)?.status).toBe('completed');
    });

    it('does not affect running turns belonging to a different task', () => {
      const otherTaskId = insertTask(db, projectId, 'other');
      const other = repo.create({ taskId: otherTaskId, kind: 'phase', phase: 'implementing', nonce: 'n1' });

      repo.supersedeRunning(taskId);

      expect(repo.findById(other.id)?.status).toBe('running');
    });
  });

  describe('appendEvent', () => {
    it('inserts an event row associated with the turn', () => {
      const turn = repo.create({ taskId, kind: 'phase', phase: 'implementing', nonce: 'n1' });

      repo.appendEvent(turn.id, { type: 'progress', payload: '{"a":1}', source: 'http' });

      const rows = db.prepare('SELECT * FROM agent_turn_events WHERE turn_id = ?').all(turn.id) as Array<{
        type: string;
        payload: string;
        source: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe('progress');
      expect(rows[0].payload).toBe('{"a":1}');
      expect(rows[0].source).toBe('http');
    });

    it('truncates payloads larger than 256KB', () => {
      const turn = repo.create({ taskId, kind: 'phase', phase: 'implementing', nonce: 'n1' });
      const oversized = 'x'.repeat(300 * 1024);

      repo.appendEvent(turn.id, { type: 'progress', payload: oversized, source: 'http' });

      const row = db.prepare('SELECT payload FROM agent_turn_events WHERE turn_id = ?').get(turn.id) as { payload: string };
      expect(Buffer.byteLength(row.payload, 'utf-8')).toBe(256 * 1024);
    });

    it('stores a null payload as null', () => {
      const turn = repo.create({ taskId, kind: 'phase', phase: 'implementing', nonce: 'n1' });

      repo.appendEvent(turn.id, { type: 'duplicate', payload: null, source: 'http' });

      const row = db.prepare('SELECT payload FROM agent_turn_events WHERE turn_id = ?').get(turn.id) as { payload: string | null };
      expect(row.payload).toBeNull();
    });
  });

  describe('findLatestEventByType', () => {
    it('returns the most recent event of the given type for a turn', () => {
      const turn = repo.create({ taskId, kind: 'phase', phase: 'implementing', nonce: 'n1' });
      repo.appendEvent(turn.id, { type: 'complete', payload: '{"output":"first"}', source: 'http' });
      repo.appendEvent(turn.id, { type: 'complete', payload: '{"output":"second"}', source: 'http' });

      const event = repo.findLatestEventByType(turn.id, 'complete');

      expect(event?.payload).toBe('{"output":"second"}');
      expect(event?.turnId).toBe(turn.id);
      expect(event?.type).toBe('complete');
    });

    it('ignores events of other types', () => {
      const turn = repo.create({ taskId, kind: 'phase', phase: 'implementing', nonce: 'n1' });
      repo.appendEvent(turn.id, { type: 'progress', payload: null, source: 'http' });

      expect(repo.findLatestEventByType(turn.id, 'complete')).toBeNull();
    });

    it('returns null when the turn has no events', () => {
      const turn = repo.create({ taskId, kind: 'phase', phase: 'implementing', nonce: 'n1' });

      expect(repo.findLatestEventByType(turn.id, 'complete')).toBeNull();
    });
  });
});
