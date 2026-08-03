import type { SqliteAgentTurnRepository } from './SqliteAgentTurnRepository';
import type { TurnSignalHub } from './TurnSignalHub';
import type { SupervisorActivityEvent } from '../../supervisors/SupervisorRegistry';

export interface SupervisorProgressBridgeDeps {
  agentTurnRepo: Pick<SqliteAgentTurnRepository, 'findRunningByTask'>;
  turnSignalHub: Pick<TurnSignalHub, 'emitSignal'>;
}

/**
 * Bridges `SupervisorRegistry`'s `activity` events into `TurnSignalHub` as
 * `progress` signals, so `WorkerWaiter`'s idle timeout (`lastDataTime`, see
 * `InProcessSignalStream`'s `progress` handling) is refreshed while a
 * supervised child process is actively producing output — the supervisor's
 * `ActivityTracker` re-sends `active` every ~15s while activity continues,
 * which comfortably beats `IDLE_TIMEOUT` (120s) from ever firing spuriously
 * during supervised execution.
 *
 * Only `state === 'active'` refreshes anything: `idle` carries no signal of
 * its own here (idle timeout is exactly what should elapse in that case), and
 * a `taskId`-less event (no task associated with this supervised process)
 * has nothing to look up a turn against.
 */
export function bridgeSupervisorActivityToProgress(
  event: Pick<SupervisorActivityEvent, 'taskId' | 'state'>,
  deps: SupervisorProgressBridgeDeps,
): void {
  if (event.state !== 'active' || event.taskId == null) return;
  const turn = deps.agentTurnRepo.findRunningByTask(event.taskId);
  if (!turn) return;
  deps.turnSignalHub.emitSignal(turn.id, { type: 'progress' });
}
