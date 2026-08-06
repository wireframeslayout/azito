import type { EventEmitter } from 'events';
import type { IExecutionLogRepository, LogType } from '../ExecutionLog';

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
