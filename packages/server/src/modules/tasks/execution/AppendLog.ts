import type { EventEmitter } from 'events';
import type { IExecutionLogRepository, LogType } from '../ExecutionLog';
import type { ITaskRepository } from '../Task';

/**
 * Writes an execution-log entry AND emits it on the shared task-events
 * EventEmitter (Issue #328 fifteenth-round review) — the single thing that
 * turns a `'status_change'` entry into a live browser notification: see
 * buildServer.ts's "Task status → NotificationBus bridge" and "Push
 * notifications on task status changes", both of which subscribe to this
 * same emitter's `'log'` event, not to the execution_log TABLE.
 *
 * `IExecutionLogRepository.append()` alone only persists a row — nothing
 * reads that table to drive a live notification. Before this function
 * existed, TaskRestoreService.restore() and WindowRespawnService's
 * execution-gate enforcement called `logRepo.append()` directly (its own
 * inline comment in TaskRestoreService.ts claimed otherwise — see that
 * file's Issue #328 fifteenth-round review fix), so a `pending_approval`
 * block from either path was recorded in the DB but never reached a human:
 * no WS `task:status` event, no push notification, no live UI update.
 * `WindowRespawnService.enforceExecutionGate` additionally never wrote a
 * `'status_change'` entry at all for that case, only a `'command'` one.
 *
 * ExecuteTaskUseCase (and PhaseLoopRunner, which shares ExecuteTaskUseCase's
 * private `appendLog` via constructor injection) already paired
 * `logRepo.append()` with `events.emit('log', ...)` correctly — this
 * function is now the ONE place that pairing lives, shared by
 * ExecuteTaskUseCase, TaskRestoreService, and WindowRespawnService, so a
 * future execution-gate call site can't reintroduce the same silent-log bug
 * by calling `logRepo.append()` on its own.
 */
export function appendLogAndEmit(
  logRepo: IExecutionLogRepository,
  events: EventEmitter,
  taskId: number,
  unitId: number,
  type: LogType,
  content: unknown,
): void {
  logRepo.append(taskId, unitId, type, content);
  events.emit('log', { taskId, unitId, type, content, createdAt: new Date().toISOString() });
}

/**
 * Minimal logger shape this module needs — just `error()`, matching both
 * Fastify's `request.log` and the `ApprovalLogger` used elsewhere in this
 * package, so callers don't have to depend on either type directly.
 */
export interface FailureLogger {
  error(obj: unknown, msg?: string): void;
}

/**
 * Shared failure handler for a fire-and-forget async resume/execute call
 * (`.catch(...)` on `followUp()`/`resumeStateMachine()`/`execute()`) that
 * has ALREADY returned `{ ok: true }` (or similar) to the HTTP caller by the
 * time it rejects. Three call sites — `decideExecutionApproval`'s
 * `failApprovedOperation`, `POST /api/tasks/:id/answer`'s follow-up catch,
 * and `POST /api/units/:id/approve-plan`'s `failResumedOperation` — used to
 * each hand-write this same "log the error, mark the task failed" sequence,
 * and two of the three (answer / approve-plan) wrote the DB transition with
 * a raw `logRepo.append()`/`taskRepo.update()` only, never emitting on the
 * shared `events` EventEmitter — see `appendLogAndEmit`'s doc comment for
 * why that matters: without the emit, no WS `task:status` event and no push
 * notification reach the client, so it sits at `waiting_input`/`phase_review`
 * forever with no visible sign the task actually failed.
 *
 * Always transitions to `'failed'` — every existing call site already did,
 * and this is specifically the "an approved/resumed operation blew up after
 * the fact" case, not a general-purpose failure path.
 */
export function failAsyncTaskOperation(
  deps: { taskRepo: Pick<ITaskRepository, 'update'>; logRepo: IExecutionLogRepository; events: EventEmitter; log: FailureLogger },
  taskId: number,
  unitId: number | null,
  operation: string,
  err: unknown,
  logMessage: string,
): void {
  const { taskRepo, logRepo, events, log } = deps;
  const message = err instanceof Error ? err.message : String(err);
  log.error({ err, taskId, operation }, logMessage);
  taskRepo.update(taskId, { status: 'failed' });
  if (unitId !== null) {
    appendLogAndEmit(logRepo, events, taskId, unitId, 'command', { type: 'approved_operation_failed', operation, message });
    appendLogAndEmit(logRepo, events, taskId, unitId, 'status_change', { status: 'failed', operation, message });
  }
}
