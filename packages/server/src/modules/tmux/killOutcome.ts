import type { ExecResult } from '../servers/transport/ServerTransport';

export interface KillOutcome {
  /** The kill actually happened (exit code 0) or the target was already gone. */
  success: boolean;
  /** The target didn't exist to begin with (tmux reported "not found"), not a real failure. */
  alreadyGone: boolean;
  result: ExecResult;
}

/**
 * Normalizes a `TmuxClient.killWindow`/`killSession` outcome across
 * transports into one success/failure verdict.
 *
 * `LocalTransport.execTmux` rejects the promise on a non-zero tmux exit
 * (`execFile`'s `err` callback arg), but `AgentTransport.execTmux` never
 * rejects on the remote command's own exit code — it POSTs to the agent's
 * `/api/tmux` and resolves with whatever `ExecResult` (including a non-zero
 * `code`) the agent process returns, only rejecting on an HTTP-level
 * failure. A caller that treats "the promise resolved" as "the kill
 * succeeded" is therefore correct for `local` servers and silently wrong for
 * `agent` servers: a failed kill (pane still alive) reads as success there,
 * which previously let rollback paths revoke a task token generation while
 * the pane holding it was, in fact, still running (Issue #28 third-party
 * review finding 2).
 *
 * This is the single place that decides "did the kill actually work" —
 * every caller that needs that answer goes through it instead of
 * reimplementing the code/already-gone check inline (there used to be two
 * independent implementations: this one's ancestor in
 * `modules/tmux/routes/sessions.ts`, and a bare `.then(() => true, () =>
 * false)` in a handful of task-execution rollback paths that didn't even
 * look at `code`).
 */
export async function resolveKillOutcome(execTmux: Promise<ExecResult>): Promise<KillOutcome> {
  let result: ExecResult;
  try {
    result = await execTmux;
  } catch (err) {
    result = { stdout: '', stderr: err instanceof Error ? err.message : String(err), code: 1 };
  }
  if (result.code === 0) {
    return { success: true, alreadyGone: false, result };
  }
  const output = `${result.stderr || ''}${result.stdout || ''}`;
  // tmux's own wording differs slightly between kill-window ("can't find
  // window") and kill-session ("can't find session" / "no such session") —
  // matching the shared "can't find" substring plus the session-only
  // "no such session" phrasing covers both without the caller having to
  // pick a pattern.
  const alreadyGone = output.includes("can't find") || output.includes('no such session');
  return { success: alreadyGone, alreadyGone, result };
}
