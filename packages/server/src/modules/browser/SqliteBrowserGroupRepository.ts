import type { Database as SqliteDatabase } from 'better-sqlite3';

/**
 * Persists which task (if any) opened a given browser group (`groupId` is
 * always server-minted at open time — see `openBrowserTab.ts`/the agent
 * process's own equivalent — never caller-supplied, so there is never a
 * pre-existing row to collide with when `POST /api/browser/open` records
 * one). Backs the task-principal authorization scoping on `/api/browser/
 * open` and `/api/browser/close-group` (Issue #28 Phase E, design v3 §11):
 * a task may only ever act on a group it itself opened.
 *
 * `taskId: null` records an operator-opened group (unowned/shared — the
 * browser panel UI, not a task script). A task principal never owns one of
 * these, so `findOwnerTaskId` returning `null` here still correctly denies
 * a task-principal `close-group` call.
 */
export class SqliteBrowserGroupRepository {
  private recordStmt;
  private findStmt;
  private removeStmt;
  private removeAllForServerStmt;

  constructor(private db: SqliteDatabase) {
    this.recordStmt = db.prepare(
      'INSERT INTO browser_groups (group_id, server_name, task_id) VALUES (?, ?, ?)',
    );
    this.findStmt = db.prepare(
      'SELECT task_id FROM browser_groups WHERE server_name = ? AND group_id = ?',
    );
    this.removeStmt = db.prepare(
      'DELETE FROM browser_groups WHERE server_name = ? AND group_id = ?',
    );
    this.removeAllForServerStmt = db.prepare(
      'DELETE FROM browser_groups WHERE server_name = ?',
    );
  }

  /** Called once, right after `POST /api/browser/open` successfully mints a new group. */
  recordOwner(serverName: string, groupId: string, taskId: number | null): void {
    this.recordStmt.run(groupId, serverName, taskId);
  }

  /**
   * Returns the owning task id, `null` for an operator-opened (unowned)
   * group, or `undefined` when the group is not recorded at all (e.g. a
   * group opened before this table existed, or an agent-server group whose
   * `POST /api/browser/open` recording failed) — callers enforcing
   * ownership must treat `undefined` as "not this task's", same as `null`,
   * never as "unknown, so allow".
   */
  findOwnerTaskId(serverName: string, groupId: string): number | null | undefined {
    const row = this.findStmt.get(serverName, groupId) as { task_id: number | null } | undefined;
    if (!row) return undefined;
    return row.task_id;
  }

  /** Best-effort hygiene call from `close-group` — never the sole source of truth for "is this group gone" (BrowserSessionManager owns that). */
  remove(serverName: string, groupId: string): void {
    this.removeStmt.run(serverName, groupId);
  }

  /**
   * Clears every ownership row for `serverName` in one statement (Issue #28
   * review fix 4). Called from `BrowserSessionManager.stop()` — a whole
   * browser session shutdown (explicit `POST /api/browser/stop` or the idle
   * session timeout) destroys every group that session held, so every
   * ownership row scoped to that server is stale the instant it completes.
   * Without this, a server whose browser process gets stopped and later
   * relaunched would carry forward `browser_groups` rows for groups that no
   * longer exist anywhere.
   */
  removeAllForServer(serverName: string): void {
    this.removeAllForServerStmt.run(serverName);
  }
}
