import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

// Issue #29 review, Important finding 3: verifies updateIsolationIntent()
// atomically clears isolation_verified_at/isolation_report in the same
// UPDATE as the intent flip. Full migration chain must be replayed against a
// fresh in-memory DB — same approach as 061_isolation_profile.test.ts /
// SqliteWindowRepository.test.ts (isolation_intent/verified_at/report are
// added in migration 061).
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

import { SqliteServerRepository } from './SqliteServerRepository';

interface Migration {
  version: number;
  up: (db: Database.Database) => void;
}

const ALL_MIGRATIONS: Migration[] = [
  m001, m002, m003, m004, m005, m006, m007, m008, m009, m010,
  m011, m012, m013, m014, m015, m016, m017, m018, m019, m020,
  m021, m022, m023, m024, m025, m026, m027, m028, m029, m030,
  m031, m032, m033, m034, m035, m036, m037, m038, m039, m040,
  m041, m042, m043, m044, m045, m046, m047, m048, m049, m050,
  m051, m052, m053, m054, m055, m056, m057, m058, m059, m060, m061, m062,
];

// Same table-rebuild toggle as the real migration runner in Database.ts.
const MIGRATIONS_REQUIRING_TABLE_REBUILD = new Set([36, 37, 42, 46]);

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

describe('SqliteServerRepository — isolation_intent transitions (Issue #29 review, Important finding 3)', () => {
  it('clears isolation_verified_at, isolation_report AND isolation_cleanup_report atomically when intent flips true -> false', () => {
    const db = buildSeededDb();
    db.prepare(`INSERT INTO servers (name, type) VALUES ('srv', 'agent')`).run();
    db.prepare('UPDATE servers SET isolation_intent = 1, isolation_verified_at = ?, isolation_report = ?, isolation_cleanup_report = ? WHERE name = ?')
      .run('2026-08-01T00:00:00Z', JSON.stringify({ kind: 'verification', verified: true, checks: [] }), JSON.stringify({ kind: 'cleanup', cleanup: 'done' }), 'srv');

    const repo = new SqliteServerRepository(db);
    repo.updateIsolationIntent('srv', false);

    const row = db.prepare('SELECT isolation_intent, isolation_verified_at, isolation_report, isolation_cleanup_report FROM servers WHERE name = ?').get('srv') as Record<string, unknown>;
    expect(row.isolation_intent).toBe(0);
    expect(row.isolation_verified_at).toBeNull();
    expect(row.isolation_report).toBeNull();
    expect(row.isolation_cleanup_report).toBeNull();
  });

  // Issue #29 review (final pass), Important finding 2: a false->true flip
  // no longer clears the cleanup report to NULL — it atomically initializes
  // it to the pending marker instead, in the SAME statement as the intent
  // flip, so a crash between this commit and attemptIsolationCleanup's own
  // write never leaves `isolation_intent=1` with a report indistinguishable
  // from "cleanup not yet attempted" vs "cleanup silently never ran" (see
  // Server.ts's ISOLATION_CLEANUP_PENDING_REPORT doc comment).
  //
  // Review round (Important finding 4): the pending marker now lands in
  // isolation_cleanup_report specifically — isolation_report (the DOCTOR's
  // verification column, split out this round) is unconditionally cleared to
  // NULL on every intent flip instead, same as isolation_verified_at.
  it('initializes isolation_cleanup_report to the pending marker and clears isolation_report/verified_at when intent flips false -> true', () => {
    const db = buildSeededDb();
    db.prepare(`INSERT INTO servers (name, type) VALUES ('srv', 'agent')`).run();
    db.prepare('UPDATE servers SET isolation_intent = 0, isolation_verified_at = ?, isolation_report = ? WHERE name = ?')
      .run('2026-07-01T00:00:00Z', JSON.stringify({ kind: 'verification', verified: false, checks: [] }), 'srv');

    const repo = new SqliteServerRepository(db);
    repo.updateIsolationIntent('srv', true);

    const row = db.prepare('SELECT isolation_intent, isolation_verified_at, isolation_report, isolation_cleanup_report FROM servers WHERE name = ?').get('srv') as Record<string, unknown>;
    expect(row.isolation_intent).toBe(1);
    expect(row.isolation_verified_at).toBeNull();
    expect(row.isolation_report).toBeNull();
    expect(JSON.parse(row.isolation_cleanup_report as string)).toEqual({ kind: 'cleanup', cleanup: 'pending' });
  });

  it('a subsequent updateIsolationCleanupReport() write after the intent flip is not clobbered by the clear', () => {
    const db = buildSeededDb();
    db.prepare(`INSERT INTO servers (name, type) VALUES ('srv', 'agent')`).run();

    const repo = new SqliteServerRepository(db);
    repo.updateIsolationIntent('srv', true);
    repo.updateIsolationCleanupReport('srv', JSON.stringify({ kind: 'cleanup', cleanup: 'done', at: '2026-08-15T00:00:00Z' }));

    const row = db.prepare('SELECT isolation_cleanup_report FROM servers WHERE name = ?').get('srv') as Record<string, unknown>;
    const report = JSON.parse(row.isolation_cleanup_report as string);
    expect(report.kind).toBe('cleanup');
    expect(report.cleanup).toBe('done');
  });

  // Review round (Important finding 4): updateIsolationReport (verification
  // column) and updateIsolationCleanupReport (cleanup column) must never
  // write to each other's column — a doctor run must not be able to clobber
  // a settled cleanup outcome, or vice versa.
  it('updateIsolationReport and updateIsolationCleanupReport write independent columns', () => {
    const db = buildSeededDb();
    db.prepare(`INSERT INTO servers (name, type) VALUES ('srv', 'agent')`).run();

    const repo = new SqliteServerRepository(db);
    repo.updateIsolationReport('srv', JSON.stringify({ kind: 'verification', verified: true, checks: [] }));
    repo.updateIsolationCleanupReport('srv', JSON.stringify({ kind: 'cleanup', cleanup: 'done' }));

    const row = db.prepare('SELECT isolation_report, isolation_cleanup_report FROM servers WHERE name = ?').get('srv') as Record<string, unknown>;
    expect(JSON.parse(row.isolation_report as string).kind).toBe('verification');
    expect(JSON.parse(row.isolation_cleanup_report as string).kind).toBe('cleanup');
  });

  // Issue #29 review, Important finding 1: PUT /api/servers/:name's
  // "effective type no longer agent -> auto-clear isolation" path used to
  // run the connection-info UPDATE and the isolation-intent clear as two
  // separate statements — a crash (or any error) between them left the row
  // with the new type but isolation_intent still 1. updateWithIsolationClear
  // must commit both in one transaction, and roll back both if either half
  // fails.
  describe('updateWithIsolationClear()', () => {
    it('commits the connection-info update and the isolation-intent clear (both report columns) together', () => {
      const db = buildSeededDb();
      db.prepare(`INSERT INTO servers (name, type) VALUES ('srv', 'agent')`).run();
      db.prepare('UPDATE servers SET isolation_intent = 1, isolation_verified_at = ?, isolation_report = ?, isolation_cleanup_report = ? WHERE name = ?')
        .run('2026-08-01T00:00:00Z', JSON.stringify({ kind: 'verification', verified: true, checks: [] }), JSON.stringify({ kind: 'cleanup', cleanup: 'done' }), 'srv');

      const repo = new SqliteServerRepository(db);
      repo.updateWithIsolationClear('srv', 'local', undefined, undefined, undefined, undefined, 'system');

      const row = db.prepare('SELECT type, isolation_intent, isolation_verified_at, isolation_report, isolation_cleanup_report FROM servers WHERE name = ?').get('srv') as Record<string, unknown>;
      expect(row.type).toBe('local');
      expect(row.isolation_intent).toBe(0);
      expect(row.isolation_verified_at).toBeNull();
      expect(row.isolation_report).toBeNull();
      expect(row.isolation_cleanup_report).toBeNull();
    });

    it('rolls back the connection-info update if the isolation-intent clear fails', () => {
      const db = buildSeededDb();
      db.prepare(`INSERT INTO servers (name, type) VALUES ('srv', 'agent')`).run();
      db.prepare('UPDATE servers SET isolation_intent = 1, isolation_verified_at = ?, isolation_report = ?, isolation_cleanup_report = ? WHERE name = ?')
        .run('2026-08-01T00:00:00Z', JSON.stringify({ kind: 'verification', verified: true, checks: [] }), JSON.stringify({ kind: 'cleanup', cleanup: 'done' }), 'srv');

      const repo = new SqliteServerRepository(db);
      // Force the second statement in the transaction to fail after the
      // first (the connection-info UPDATE) has already run, simulating a
      // crash/error between the two writes.
      const isolationStmt = (repo as unknown as { updateIsolationIntentStmt: { run: (...args: unknown[]) => unknown } }).updateIsolationIntentStmt;
      const originalRun = isolationStmt.run.bind(isolationStmt);
      isolationStmt.run = () => { throw new Error('simulated failure'); };

      expect(() => repo.updateWithIsolationClear('srv', 'local', undefined, undefined, undefined, undefined, 'system')).toThrow('simulated failure');

      isolationStmt.run = originalRun;
      const row = db.prepare('SELECT type, isolation_intent, isolation_verified_at, isolation_report, isolation_cleanup_report FROM servers WHERE name = ?').get('srv') as Record<string, unknown>;
      // Both halves rolled back: type is still 'agent' (not 'local'), and
      // isolation_intent/verified_at/report/cleanup_report are untouched —
      // proving the two statements share a single transaction rather than
      // committing independently.
      expect(row.type).toBe('agent');
      expect(row.isolation_intent).toBe(1);
      expect(row.isolation_verified_at).toBe('2026-08-01T00:00:00Z');
      expect(JSON.parse(row.isolation_report as string)).toEqual({ kind: 'verification', verified: true, checks: [] });
      expect(JSON.parse(row.isolation_cleanup_report as string)).toEqual({ kind: 'cleanup', cleanup: 'done' });
    });
  });

  // Issue #29 Step 2 B: updateIsolationVerification() is the isolation
  // doctor's own writer — must set isolation_report AND isolation_verified_at
  // atomically in the same statement (see IServerRepository's doc comment on
  // why: a reader must never observe one field updated without the other).
  describe('updateIsolationVerification (Issue #29 Step 2 B)', () => {
    it('sets isolation_report and isolation_verified_at together', () => {
      const db = buildSeededDb();
      db.prepare(`INSERT INTO servers (name, type) VALUES ('srv', 'agent')`).run();
      db.prepare('UPDATE servers SET isolation_intent = 1 WHERE name = ?').run('srv');

      const repo = new SqliteServerRepository(db);
      const report = JSON.stringify({ kind: 'verification', verified: true, checks: [] });
      repo.updateIsolationVerification('srv', report, '2026-08-16T00:00:00Z');

      const row = db.prepare('SELECT isolation_report, isolation_verified_at FROM servers WHERE name = ?').get('srv') as Record<string, unknown>;
      expect(row.isolation_report).toBe(report);
      expect(row.isolation_verified_at).toBe('2026-08-16T00:00:00Z');
    });

    it('does not touch isolation_intent itself', () => {
      const db = buildSeededDb();
      db.prepare(`INSERT INTO servers (name, type) VALUES ('srv', 'agent')`).run();
      db.prepare('UPDATE servers SET isolation_intent = 1 WHERE name = ?').run('srv');

      const repo = new SqliteServerRepository(db);
      repo.updateIsolationVerification('srv', JSON.stringify({ kind: 'verification', verified: true, checks: [] }), '2026-08-16T00:00:00Z');

      const row = db.prepare('SELECT isolation_intent FROM servers WHERE name = ?').get('srv') as Record<string, unknown>;
      expect(row.isolation_intent).toBe(1);
    });
  });
});
