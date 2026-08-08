import type { ExecResult } from '../../servers/transport/ServerTransport';
import { resolveKillOutcome, type KillOutcome } from '../../tmux/killOutcome';
import type { ITaskRepository } from '../Task';
import type { TaskPaneEnvironmentService } from './TaskPaneEnvironmentService';
import { runExclusiveForTask } from './WindowRotation';

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
