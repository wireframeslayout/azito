import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Migrations 001→038 must be replayed against a fresh in-memory DB before 039 can run
// (039 only makes sense once phase_prompts exists with its final seeded shape).
// Statically imported (rather than a dynamic `import(`./${name}.js`)`) so bundlers can
// resolve each migration module unambiguously.
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

interface Migration {
  version: number;
  up: (db: Database.Database) => void;
}

const PRIOR_MIGRATIONS: Migration[] = [
  m001, m002, m003, m004, m005, m006, m007, m008, m009, m010,
  m011, m012, m013, m014, m015, m016, m017, m018, m019, m020,
  m021, m022, m023, m024, m025, m026, m027, m028, m029, m030,
  m031, m032, m033, m034, m035, m036, m037, m038,
];

// Same table-rebuild toggle as the real migration runner in Database.ts.
const MIGRATIONS_REQUIRING_TABLE_REBUILD = new Set([36, 37]);

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

describe('migration 039: export edited phase_prompts', () => {
  let userDir: string;

  beforeEach(() => {
    userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekicks-mig039-'));
    vi.resetModules();
    process.env.AZITO_SIDEKICKS_DIR = userDir;
  });

  afterEach(() => {
    delete process.env.AZITO_SIDEKICKS_DIR;
    fs.rmSync(userDir, { recursive: true, force: true });
  });

  it('writes nothing when no phase_prompts row was edited', async () => {
    const db = buildSeededDb();
    const m039 = await import('./039_export_edited_phase_prompts.js');
    m039.up(db);

    for (const phase of ['planning', 'implementing', 'reviewing', 'testing', 'pushing']) {
      expect(fs.existsSync(path.join(userDir, `${phase}-default`, 'SKILL.md'))).toBe(false);
    }
  });

  it('exports only the edited phase to the user layer, leaving others untouched', async () => {
    const db = buildSeededDb();
    db.prepare("UPDATE phase_prompts SET prompt = ? WHERE phase = 'pushing'").run('CUSTOM EDITED PUSHING PROMPT');

    const m039 = await import('./039_export_edited_phase_prompts.js');
    m039.up(db);

    const pushingSkillPath = path.join(userDir, 'pushing-default', 'SKILL.md');
    expect(fs.existsSync(pushingSkillPath)).toBe(true);
    const content = fs.readFileSync(pushingSkillPath, 'utf-8');
    expect(content).toContain('CUSTOM EDITED PUSHING PROMPT');
    expect(content).toContain('name: pushing-default');
    expect(content).toContain('phase: pushing');
    expect(content).toContain('isDefault: true');

    expect(fs.existsSync(path.join(userDir, 'planning-default', 'SKILL.md'))).toBe(false);
  });

  it('does not overwrite an already-exported SKILL.md', async () => {
    const db = buildSeededDb();
    db.prepare("UPDATE phase_prompts SET prompt = ? WHERE phase = 'testing'").run('FIRST EDIT');

    const m039 = await import('./039_export_edited_phase_prompts.js');
    m039.up(db);

    const skillPath = path.join(userDir, 'testing-default', 'SKILL.md');
    const firstWrite = fs.readFileSync(skillPath, 'utf-8');
    expect(firstWrite).toContain('FIRST EDIT');

    // Simulate a second (re-)run of the migration against a DB with a further edit — should not clobber.
    db.prepare("UPDATE phase_prompts SET prompt = ? WHERE phase = 'testing'").run('SECOND EDIT SHOULD NOT APPEAR');
    m039.up(db);

    const secondRead = fs.readFileSync(skillPath, 'utf-8');
    expect(secondRead).toBe(firstWrite);
    expect(secondRead).not.toContain('SECOND EDIT SHOULD NOT APPEAR');
  });

  it('ignores the enabled flag when comparing (enabled=false rows are still compared by body only)', async () => {
    const db = buildSeededDb();
    db.prepare("UPDATE phase_prompts SET enabled = 0 WHERE phase = 'testing'").run();

    const m039 = await import('./039_export_edited_phase_prompts.js');
    m039.up(db);

    // Body unchanged (only enabled flipped) -> still no export.
    expect(fs.existsSync(path.join(userDir, 'testing-default', 'SKILL.md'))).toBe(false);
  });
});
