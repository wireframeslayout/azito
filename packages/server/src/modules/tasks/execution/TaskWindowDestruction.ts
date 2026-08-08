import type { ExecResult } from '../../servers/transport/ServerTransport';
import { resolveKillOutcome, type KillOutcome } from '../../tmux/killOutcome';
import type { ITaskRepository } from '../Task';
import type { TaskPaneEnvironmentService } from './TaskPaneEnvironmentService';
import { runExclusiveForTask, runExclusiveForTasks } from './WindowRotation';

/**
 * Shared "destroy a task's PRIMARY window for good" operation (Issue #28
 * third-party review, second round: kill-window/kill-session (tmux/routes/
 * sessions.ts) and `POST /api/tasks/:id/retry` each independently ran
 * "kill → revoke every active token for the task" OUTSIDE
 * {@link runExclusiveForTask} — the same per-task serialization
 * WindowRotation.ts's `createRotatedWindow`/`rollbackWindowReference` use for
 * every ROTATION. Without it, a concurrent respawn could issue and persist a
 * brand-new generation (and its window) in the gap between this call's kill
 * succeeding and its blanket `revokeForDestroyedWindow` running — that
 * blanket revoke would then take out the new, still-live generation too,
 * even though it had nothing to do with the window this call just killed.
 *
 * Running the whole "kill → reread → revoke → reference cleanup" span inside
 * one `runExclusiveForTask(taskId, …)` call fixes that: no other rotation for
 * the same task can be mid-issue while this is between kill and revoke. The
 * "reread" step is `ITaskRepository.clearTmuxWindowIfMatches` — already
 * built for exactly this purpose (see its own doc comment, Fix 3 of the
 * first review round) — a WHERE-guarded UPDATE that only clears
 * `task.tmuxWindow` (and reports `true`) if it STILL equals `windowName`,
 * i.e. no other rotation moved the task onto a newer window generation while
 * this call was killing the old one. Revoke only runs when that reread
 * confirms it; a `false` means a concurrent rotation already replaced the
 * window this call is destroying, so its own (now-current) generation must
 * be left alone.
 *
 * `kill` and `onDestroyed` are supplied by each call site (single
 * kill-window, kill-session's per-window loop, retry's abandoned-window
 * cleanup) since the actual tmux kill call and the `windows` table row
 * cleanup differ per route; this function owns only the ordering and
 * locking every one of them must share.
 */
export async function destroyPrimaryTaskWindow(
  taskId: number,
  windowName: string,
  taskRepo: Pick<ITaskRepository, 'clearTmuxWindowIfMatches'>,
  paneEnvService: TaskPaneEnvironmentService,
  reason: string,
  kill: () => Promise<ExecResult>,
  onDestroyed: () => void,
): Promise<KillOutcome> {
  return runExclusiveForTask(taskId, async () => {
    const outcome = await resolveKillOutcome(kill());
    if (outcome.success) {
      // Reread + generation-specific revoke gate: only revoke if the task's
      // CURRENT primary window is still the one this call just killed.
      const stillCurrent = taskRepo.clearTmuxWindowIfMatches(taskId, windowName);
      if (stillCurrent) {
        paneEnvService.revokeForDestroyedWindow(taskId, reason);
      }
      // Reference cleanup (windows table row removal, etc.) — always run on
      // a confirmed kill regardless of whether the token revoke fired, since
      // the destroyed window's own row must go either way.
      onDestroyed();
    }
    return outcome;
  });
}

/** One window belonging to a task, as resolved by a {@link ResolveSessionKillWindows} call. */
export interface SessionKillTaskWindow {
  taskId: number;
  windowName: string;
  /** Canonical `windows` table target (`session:windowName`) — used to report `handledTargets` to the caller. */
  target: string;
  onDestroyed: () => void;
}

/**
 * Re-resolves the FULL, current set of PRIMARY task-owned windows a session
 * holds. Must be safely callable more than once (idempotent, no side
 * effects beyond its own reads) — {@link destroyPrimaryTaskWindowsForSessionKill}
 * calls it once per lock-acquisition attempt, discarding every result but
 * the last (see that function's doc comment for why a single pre-lock call
 * is not enough).
 */
export type ResolveSessionKillWindows = () => SessionKillTaskWindow[];

const MAX_TASK_SET_RESOLVE_RETRIES = 5;

function uniqueSortedTaskIds(windows: SessionKillTaskWindow[]): number[] {
  return [...new Set(windows.map((w) => w.taskId))].sort((a, b) => a - b);
}

function sameTaskIdSet(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Session-wide sibling of {@link destroyPrimaryTaskWindow} (Issue #28
 * third-party review, D-track fix 1): `DELETE
 * /api/servers/:name/sessions/:session` kills an entire tmux session in ONE
 * call, which can tear down several tasks' primary windows at once — there
 * is no single `taskId` to serialize the kill against.
 *
 * Calling `killSession` OUTSIDE any per-task lock (the previous shape)
 * reopened the exact race `destroyPrimaryTaskWindow` exists to close, just
 * at session scope: the caller resolves which windows the session holds,
 * then — before `killSession` runs — a concurrent respawn for one of those
 * tasks (via `runExclusiveForTask` elsewhere) can land a brand-new window
 * generation. `killSession` then destroys everything (the old window AND
 * the new one, since both live in the same tmux session), but the caller's
 * pre-kill window listing still describes the OLD generation, so the
 * per-window reread (`clearTmuxWindowIfMatches`) correctly reports "no
 * longer current" for the new generation and skips revoking it — leaving a
 * destroyed pane's token valid forever (worse than the old blanket-revoke
 * behavior this whole design replaced).
 *
 * Fix: acquire every affected task's rotation lock via
 * {@link runExclusiveForTasks} BEFORE calling `killSession`, and only THEN
 * kill + reread + revoke + clean up each window — mirroring
 * `destroyPrimaryTaskWindow`'s single-task span, just widened to cover every
 * task the session's windows belong to.
 *
 * Follow-up fix (Issue #28 batch review): the FIRST version of this function
 * still took `windows`/`taskIds` as plain, already-resolved arrays, computed
 * by the caller BEFORE `runExclusiveForTasks` acquired anything. That
 * snapshot is only used to pick which tasks' queues to wait on — once this
 * call actually reaches the front of every one of those queues (which can be
 * arbitrarily later, e.g. behind an already-in-flight respawn for one of the
 * same tasks), the snapshot can be stale: a respawn that completes WHILE
 * this call is waiting on the lock lands a new window generation under a new
 * name, and the stale `windowName` this call still holds no longer matches
 * `task.tmuxWindow` — so `clearTmuxWindowIfMatches` (correctly, given a
 * stale input) reports "no longer current" and skips revoking a window that
 * `killSession` is about to destroy right along with everything else in the
 * session. Worse than the original race: a still-referenced, still-killed
 * window's token is now never revoked.
 *
 * Fix: `resolveWindows` is a callback, not a value — this function calls it
 * once for an initial (best-effort) lock-target list, then AGAIN inside the
 * lock, immediately before the kill, to get an authoritative snapshot. If
 * the re-resolved task ID set differs from the one the lock was acquired
 * for (a task entered or left the session's window set while this call was
 * queued), the lock is released and reacquired for the NEW set, and the
 * whole span retries — up to {@link MAX_TASK_SET_RESOLVE_RETRIES} times, so
 * a pathologically fast churn of respawns cannot wedge this call forever.
 * Once the task ID set is confirmed stable across a lock acquisition, no
 * further rotation for any of those tasks can land between that
 * confirmation and the kill (same guarantee `runExclusiveForTasks` always
 * provided — it just needed a fresh read to apply it to).
 *
 * Returns the `target`s of every window this call actually killed/reread/
 * revoked (`handledTargets`) so the caller's own separate cleanup of
 * secondary/non-task rows can skip them.
 */
export async function destroyPrimaryTaskWindowsForSessionKill(
  resolveWindows: ResolveSessionKillWindows,
  taskRepo: Pick<ITaskRepository, 'clearTmuxWindowIfMatches'>,
  paneEnvService: TaskPaneEnvironmentService,
  reason: string,
  killSession: () => Promise<ExecResult>,
): Promise<{ outcome: KillOutcome; handledTargets: Set<string> }> {
  let taskIds = uniqueSortedTaskIds(resolveWindows());

  for (let attempt = 0; ; attempt++) {
    const attemptResult = await runExclusiveForTasks(taskIds, async () => {
      // Authoritative re-read, taken INSIDE the lock this call now holds for
      // `taskIds` — the only point at which "no concurrent rotation for any
      // of these tasks can be mid-flight" is actually guaranteed.
      const freshWindows = resolveWindows();
      const freshTaskIds = uniqueSortedTaskIds(freshWindows);
      if (!sameTaskIdSet(taskIds, freshTaskIds)) {
        return { retry: true as const, freshTaskIds };
      }

      const outcome = await resolveKillOutcome(killSession());
      const handledTargets = new Set<string>();
      if (outcome.success) {
        for (const win of freshWindows) {
          const stillCurrent = taskRepo.clearTmuxWindowIfMatches(win.taskId, win.windowName);
          if (stillCurrent) {
            paneEnvService.revokeForDestroyedWindow(win.taskId, reason);
          }
          win.onDestroyed();
          handledTargets.add(win.target);
        }
      }
      return { retry: false as const, outcome, handledTargets };
    });

    if (!attemptResult.retry) {
      return { outcome: attemptResult.outcome, handledTargets: attemptResult.handledTargets };
    }
    if (attempt >= MAX_TASK_SET_RESOLVE_RETRIES) {
      throw new Error(
        `destroyPrimaryTaskWindowsForSessionKill: the session's task set kept changing across ${MAX_TASK_SET_RESOLVE_RETRIES} lock-reacquire retries — giving up`,
      );
    }
    taskIds = attemptResult.freshTaskIds;
  }
}
