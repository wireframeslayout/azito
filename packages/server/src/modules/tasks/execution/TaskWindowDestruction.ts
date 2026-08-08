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

/** One window belonging to a task, as resolved before a whole-session kill. */
export interface SessionKillTaskWindow {
  taskId: number;
  windowName: string;
  onDestroyed: () => void;
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
 * task the session's windows belong to. No rotation for ANY of those tasks
 * can land a new window between this call's window-listing (done by the
 * caller, before this is invoked) and its kill, because by the time this
 * function's `fn` actually starts, every one of `taskIds`' queues has
 * already drained past this point.
 *
 * `taskIds` must be the FULL, deduplicated set of task IDs `windows` covers
 * (callers are expected to pass them pre-sorted ascending — see
 * `runExclusiveForTasks`'s doc comment for why this is hygiene, not a
 * correctness requirement of this specific queue implementation).
 */
export async function destroyPrimaryTaskWindowsForSessionKill(
  taskIds: number[],
  windows: SessionKillTaskWindow[],
  taskRepo: Pick<ITaskRepository, 'clearTmuxWindowIfMatches'>,
  paneEnvService: TaskPaneEnvironmentService,
  reason: string,
  killSession: () => Promise<ExecResult>,
): Promise<KillOutcome> {
  return runExclusiveForTasks(taskIds, async () => {
    const outcome = await resolveKillOutcome(killSession());
    if (outcome.success) {
      for (const win of windows) {
        const stillCurrent = taskRepo.clearTmuxWindowIfMatches(win.taskId, win.windowName);
        if (stillCurrent) {
          paneEnvService.revokeForDestroyedWindow(win.taskId, reason);
        }
        win.onDestroyed();
      }
    }
    return outcome;
  });
}
