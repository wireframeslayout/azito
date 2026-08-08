import crypto from 'crypto';
import type { SqliteDatabase } from '../../../shared/db/Database';
import { formatTaskToken } from '../../../shared/auth/taskTokenFormat';
import type { ITaskTokenRepository, IssuedTaskToken } from './TaskToken';

function hashSecret(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

export class SqliteTaskTokenRepository implements ITaskTokenRepository {
  private insertStmt;
  private findActiveHashesByTaskStmt;
  private revokeAllForTaskStmt;
  private revokeByIdStmt;
  private nextGenerationStmt;
  private activeGenerationStmt;

  constructor(private db: SqliteDatabase) {
    this.insertStmt = db.prepare(
      'INSERT INTO task_tokens (task_id, token_hash, window_generation) VALUES (?, ?, ?)',
    );
    this.findActiveHashesByTaskStmt = db.prepare(
      'SELECT token_hash FROM task_tokens WHERE task_id = ? AND revoked_at IS NULL',
    );
    this.revokeAllForTaskStmt = db.prepare(
      "UPDATE task_tokens SET revoked_at = datetime('now'), revoke_reason = ? WHERE task_id = ? AND revoked_at IS NULL",
    );
    this.revokeByIdStmt = db.prepare(
      "UPDATE task_tokens SET revoked_at = datetime('now'), revoke_reason = ? WHERE id = ? AND revoked_at IS NULL",
    );
    // MAX() over ALL rows (not just active ones) — a generation number must
    // never be reused even after its token was revoked, or a revoked
    // capability's hash could coincidentally collide with a fresh one's
    // bookkeeping.
    this.nextGenerationStmt = db.prepare(
      'SELECT COALESCE(MAX(window_generation), 0) + 1 AS gen FROM task_tokens WHERE task_id = ?',
    );
    // At most one active row per task by construction (issueNextGeneration's
    // revoke-then-insert transaction) — MAX() here is defensive, not a
    // "pick the latest of several" aggregation.
    this.activeGenerationStmt = db.prepare(
      'SELECT MAX(window_generation) AS gen FROM task_tokens WHERE task_id = ? AND revoked_at IS NULL',
    );
  }

  issue(taskId: number, windowGeneration: number): IssuedTaskToken {
    const secret = crypto.randomBytes(32).toString('hex');
    const hash = hashSecret(secret).toString('hex');
    const result = this.insertStmt.run(taskId, hash, windowGeneration);
    return { id: Number(result.lastInsertRowid), token: formatTaskToken(taskId, secret) };
  }

  verify(taskId: number, secret: string): boolean {
    const provided = hashSecret(secret);
    const rows = this.findActiveHashesByTaskStmt.all(taskId) as { token_hash: string }[];
    for (const row of rows) {
      const stored = Buffer.from(row.token_hash, 'hex');
      if (stored.length === provided.length && crypto.timingSafeEqual(stored, provided)) return true;
    }
    return false;
  }

  revokeAllForTask(taskId: number, reason: string): number {
    const result = this.revokeAllForTaskStmt.run(reason, taskId);
    return result.changes;
  }

  revoke(tokenId: number, reason: string): number {
    const result = this.revokeByIdStmt.run(reason, tokenId);
    return result.changes;
  }

  issueNextGeneration(taskId: number, revokeReason: string): IssuedTaskToken {
    const run = this.db.transaction((tId: number, reason: string): IssuedTaskToken => {
      this.revokeAllForTaskStmt.run(reason, tId);
      const { gen } = this.nextGenerationStmt.get(tId) as { gen: number };
      const secret = crypto.randomBytes(32).toString('hex');
      const hash = hashSecret(secret).toString('hex');
      const result = this.insertStmt.run(tId, hash, gen);
      return { id: Number(result.lastInsertRowid), token: formatTaskToken(tId, secret) };
    });
    return run(taskId, revokeReason);
  }

  getActiveGeneration(taskId: number): number | null {
    const row = this.activeGenerationStmt.get(taskId) as { gen: number | null };
    return row.gen;
  }
}
