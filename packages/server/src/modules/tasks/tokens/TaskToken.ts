/** A capability row backing an AZITO_TASK_TOKEN (design v3 §2). */
export interface TaskToken {
  id: number;
  taskId: number;
  windowGeneration: number;
  issuedAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
}

/** Returned only at issuance time — the plaintext token is never persisted or re-derivable. */
export interface IssuedTaskToken {
  id: number;
  token: string;
}

export interface ITaskTokenRepository {
  /**
   * Mints a new token for `taskId` bound to `windowGeneration` (design v3
   * §2: issued only when a window is actually (re)created — wiring that
   * call site is out of scope for this phase, see AGENTS.md/Issue #28
   * Phase A note). Does not revoke any existing token for the task; the
   * caller decides whether an old generation should be revoked.
   */
  issue(taskId: number, windowGeneration: number): IssuedTaskToken;

  /** True iff `secret` hashes to an active (non-revoked) token for `taskId`. Constant-time compare. */
  verify(taskId: number, secret: string): boolean;

  /**
   * Revokes every active token for `taskId` (design v3 §2: "失効はリポジトリ
   * の状態遷移 API 1箇所に集約"). Called from SqliteTaskRepository's
   * updateStatus()/delete() in the same DB transaction as the task write —
   * never call this directly from a route/use-case to represent a task
   * status transition; add the transition to the task repository's
   * TOKEN_REVOKING_STATUSES/delete() instead so every call site benefits
   * automatically. Returns the number of rows revoked.
   */
  revokeAllForTask(taskId: number, reason: string): number;

  /**
   * Window-generation-bound rotation (Issue #28 Phase A後半,
   * TaskPaneEnvironmentService's sole write path): revokes every
   * currently-active token for `taskId` (recorded with `revokeReason`) and
   * issues a fresh one at `MAX(window_generation) + 1` for the task — all in
   * one DB transaction, so no caller ever observes two simultaneously-active
   * tokens for the same task or has to compute the next generation number
   * itself. Only called from a code path that is ACTUALLY (re)creating the
   * task's tmux window (design v3 §2: "発行は実際にウィンドウを作り直すとき
   * のみ") — resuming an existing window must not call this.
   *
   * The "タスク単位の直列化" this needs (design v3 §2) comes for free from
   * better-sqlite3's synchronous execution: the whole read-modify-write
   * sequence below runs inside `db.transaction(...)`, which is a single
   * synchronous call with no `await` inside it, so no other request on this
   * process can interleave a second issuance for the same task between the
   * revoke and the insert.
   */
  issueNextGeneration(taskId: number, revokeReason: string): IssuedTaskToken;
}
