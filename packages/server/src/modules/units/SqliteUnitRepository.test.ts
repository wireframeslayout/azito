import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../../shared/db/Database';
import { SqliteUnitRepository } from './SqliteUnitRepository';
import type { Unit } from './Unit';

type UnitInput = Omit<Unit, 'id' | 'createdAt' | 'updatedAt'>;

function buildUnitInput(overrides: Partial<UnitInput> = {}): UnitInput {
  return {
    name: 'u',
    unitType: 'devops',
    systemPrompt: null,
    selfReviewMaxAttempts: 2,
    reviewSubagent: null,
    implementSubagent: null,
    phaseConfig: null,
    workerType: null,
    workerModel: null,
    workerExtraArgs: null,
    workerExecutionMode: 'tmux-pipe',
    workerRuntime: 'tui',
    sleepAfterPush: false,
    ...overrides,
  };
}

describe('SqliteUnitRepository subagent config persistence (Issue #462)', () => {
  let db: SqliteDatabase;
  let repo: SqliteUnitRepository;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new SqliteUnitRepository(db);
  });

  it('returns null when subagent fields are omitted', () => {
    const input = buildUnitInput();
    delete (input as Partial<UnitInput>).reviewSubagent;
    delete (input as Partial<UnitInput>).implementSubagent;
    const id = repo.create(input);
    const unit = repo.findById(id);
    expect(unit?.reviewSubagent).toBeNull();
    expect(unit?.implementSubagent).toBeNull();
  });

  it('stores SQL NULL, not the string "null", when subagent fields are explicitly null', () => {
    const id = repo.create(buildUnitInput({ reviewSubagent: null, implementSubagent: null }));
    const row = db.prepare('SELECT review_subagent, implement_subagent FROM units WHERE id = ?').get(id);
    expect(row).toEqual({ review_subagent: null, implement_subagent: null });
    const unit = repo.findById(id);
    expect(unit?.reviewSubagent).toBeNull();
    expect(unit?.implementSubagent).toBeNull();
  });

  it('round-trips a valid subagent config', () => {
    const review = { enabled: true, provider: 'codex', model: 'gpt-5-codex' };
    const implement = { enabled: false, provider: 'claude', model: 'sonnet' };
    const id = repo.create(buildUnitInput({ reviewSubagent: review, implementSubagent: implement }));
    const unit = repo.findById(id);
    expect(unit?.reviewSubagent).toEqual(review);
    expect(unit?.implementSubagent).toEqual(implement);
  });

  it('reads a legacy row holding the literal string "null" as null', () => {
    const id = repo.create(buildUnitInput());
    db.prepare("UPDATE units SET review_subagent = 'null', implement_subagent = 'null' WHERE id = ?").run(id);
    const unit = repo.findById(id);
    expect(unit?.reviewSubagent).toBeNull();
    expect(unit?.implementSubagent).toBeNull();
  });
});
