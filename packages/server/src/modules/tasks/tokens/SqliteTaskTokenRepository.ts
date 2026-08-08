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
}
