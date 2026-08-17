import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase, type SqliteDatabase } from '../../../shared/db/Database';
import { SqliteTaskTokenRepository } from './SqliteTaskTokenRepository';
import { parseTaskTokenHeader } from '../../../shared/auth/taskTokenFormat';

describe('SqliteTaskTokenRepository', () => {
  let db: SqliteDatabase;
  let repo: SqliteTaskTokenRepository;
  let taskId: number;

  beforeEach(() => {
    db = openDatabase(':memory:');
    repo = new SqliteTaskTokenRepository(db);
    db.prepare("INSERT INTO projects (id, name, slug, default_branch) VALUES (1, 'P', 'p', 'main')").run();
    taskId = Number(
      db.prepare(
        `INSERT INTO tasks (project_id, title, status, priority, self_review_count, require_plan_approval, source, skip_pr)
         VALUES (1, 'Test task', 'open', 0, 0, 1, 'local', 0)`,
      ).run().lastInsertRowid,
    );
  });

  it('issue() returns a well-formed azt.task.<id>.<secret> token and never stores the plaintext', () => {
    const issued = repo.issue(taskId, 1);
    const parsed = parseTaskTokenHeader(`Bearer ${issued.token}`);
    expect(parsed).toEqual({ taskId, secret: parsed?.secret });
    expect(parsed?.secret).toMatch(/^[0-9a-f]{64}$/);

    const row = db.prepare('SELECT token_hash FROM task_tokens WHERE id = ?').get(issued.id) as { token_hash: string };
    expect(row.token_hash).not.toBe(parsed?.secret);
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verify() returns true for the correct secret and false for a wrong one', () => {
    const issued = repo.issue(taskId, 1);
    const parsed = parseTaskTokenHeader(`Bearer ${issued.token}`)!;

    expect(repo.verify(taskId, parsed.secret)).toBe(true);
    expect(repo.verify(taskId, 'f'.repeat(64))).toBe(false);
  });

  it('verify() returns false for the right secret under the wrong taskId', () => {
    const otherTaskId = Number(
      db.prepare(
        `INSERT INTO tasks (project_id, title, status, priority, self_review_count, require_plan_approval, source, skip_pr)
         VALUES (1, 'Other task', 'open', 0, 0, 1, 'local', 0)`,
      ).run().lastInsertRowid,
    );
    const issued = repo.issue(taskId, 1);
    const parsed = parseTaskTokenHeader(`Bearer ${issued.token}`)!;

    expect(repo.verify(otherTaskId, parsed.secret)).toBe(false);
  });

  it('revokeAllForTask() invalidates every active token for that task and returns the revoked count', () => {
    const first = repo.issue(taskId, 1);
    const second = repo.issue(taskId, 2);
    const firstSecret = parseTaskTokenHeader(`Bearer ${first.token}`)!.secret;
    const secondSecret = parseTaskTokenHeader(`Bearer ${second.token}`)!.secret;

    const revoked = repo.revokeAllForTask(taskId, 'task_status:review');

    expect(revoked).toBe(2);
    expect(repo.verify(taskId, firstSecret)).toBe(false);
    expect(repo.verify(taskId, secondSecret)).toBe(false);
  });

  it('verify() ignores an already-revoked token even if a later call reissues a token for the same task', () => {
    const issued = repo.issue(taskId, 1);
    const secret = parseTaskTokenHeader(`Bearer ${issued.token}`)!.secret;
    repo.revokeAllForTask(taskId, 'task_status:done');

    const reissued = repo.issue(taskId, 2);
    const reissuedSecret = parseTaskTokenHeader(`Bearer ${reissued.token}`)!.secret;

    expect(repo.verify(taskId, secret)).toBe(false);
    expect(repo.verify(taskId, reissuedSecret)).toBe(true);
  });

  it('revokeAllForTask() is a no-op (returns 0) when no active tokens exist', () => {
    expect(repo.revokeAllForTask(taskId, 'task_deleted')).toBe(0);
  });

  describe('issueNextGeneration()', () => {
    it('issues generation 1 for a task with no prior tokens', () => {
      const issued = repo.issueNextGeneration(taskId, 'window_regenerated');
      const row = db.prepare('SELECT window_generation FROM task_tokens WHERE id = ?').get(issued.id) as { window_generation: number };
      expect(row.window_generation).toBe(1);
    });

    it('revokes the previously-active token and issues the next generation, so exactly one token is ever active at a time', () => {
      const first = repo.issueNextGeneration(taskId, 'window_regenerated');
      const firstSecret = parseTaskTokenHeader(`Bearer ${first.token}`)!.secret;

      const second = repo.issueNextGeneration(taskId, 'window_regenerated');
      const secondSecret = parseTaskTokenHeader(`Bearer ${second.token}`)!.secret;

      expect(repo.verify(taskId, firstSecret)).toBe(false);
      expect(repo.verify(taskId, secondSecret)).toBe(true);

      const rows = db.prepare('SELECT window_generation, revoked_at FROM task_tokens WHERE task_id = ? ORDER BY id').all(taskId) as
        { window_generation: number; revoked_at: string | null }[];
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ window_generation: 1 });
      expect(rows[0].revoked_at).toBeTruthy();
      expect(rows[1]).toMatchObject({ window_generation: 2, revoked_at: null });
    });

    it('never reuses a generation number even for a task whose only prior token was revoked via revokeAllForTask directly', () => {
      repo.issue(taskId, 5);
      repo.revokeAllForTask(taskId, 'task_status:review');

      const next = repo.issueNextGeneration(taskId, 'window_regenerated');
      const row = db.prepare('SELECT window_generation FROM task_tokens WHERE id = ?').get(next.id) as { window_generation: number };
      expect(row.window_generation).toBe(6);
    });
  });

  // Issue #28 third-party review fix: backs POST /api/tasks/:id/children's
  // per-run rate limit — the route resolves the calling task's CURRENT
  // generation through this method.
  describe('getActiveGeneration()', () => {
    it('returns null for a task that has never had a token issued', () => {
      expect(repo.getActiveGeneration(taskId)).toBeNull();
    });

    it('returns the generation of the single active token', () => {
      repo.issueNextGeneration(taskId, 'window_regenerated');
      expect(repo.getActiveGeneration(taskId)).toBe(1);
    });

    it('returns the NEW generation after a rotation, not the revoked one', () => {
      repo.issueNextGeneration(taskId, 'window_regenerated');
      repo.issueNextGeneration(taskId, 'window_regenerated');
      expect(repo.getActiveGeneration(taskId)).toBe(2);
    });

    it('returns null once every generation has been revoked (no rotation, direct revokeAllForTask)', () => {
      repo.issueNextGeneration(taskId, 'window_regenerated');
      repo.revokeAllForTask(taskId, 'task_status:archived');
      expect(repo.getActiveGeneration(taskId)).toBeNull();
    });
  });
});
