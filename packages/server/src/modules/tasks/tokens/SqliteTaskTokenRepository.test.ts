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
});
