import { randomUUID } from 'crypto';
import type { Unit } from '../../units/Unit';
import { buildWorkerLaunch } from '../../agents/LaunchCommand';
import type { ISessionStrategy, ISessionStrategyFactory } from '../../agents/SessionStrategy';
import { withFlags, type WorkerLaunch } from '../../agents/WorkerLaunch';

/** How a task's worker is started the first time: the launch (with the session id it is given) and the strategy that owns its session. */
export interface NewWorkerLaunchPlan {
  launch: WorkerLaunch;
  /** The session id the launch carries (and the task / window record); null when the agent keeps no session. */
  sessionId: string | null;
  strategy: ISessionStrategy;
}

/**
 * The launch of a unit's worker for a task's first run, decided once and before any window exists: a host that starts the worker as a
 * program (Windows) needs it to create the window, a host that types it into a pane renders it after the window is made.
 * Null when the unit has no worker to start.
 */
export function planNewWorkerLaunch(
  unit: Pick<Unit, 'workerType' | 'workerModel' | 'workerExtraArgs'>,
  strategies: ISessionStrategyFactory,
): NewWorkerLaunchPlan | null {
  const base = buildWorkerLaunch(unit.workerType, unit.workerModel, unit.workerExtraArgs);
  if (!base) return null;
  const strategy = strategies.create(unit.workerType);
  if (!strategy.supportsSession) return { launch: base, sessionId: null, strategy };
  const sessionId = randomUUID();
  return { launch: withFlags(base, strategy.buildNewSessionArgs(sessionId)), sessionId, strategy };
}

/**
 * The launch of a unit's worker that continues a task's earlier session (a follow-up that has to start the worker again): the session's
 * resume arguments after the launch, when the task has a session and the agent can resume it.
 */
export function planResumeWorkerLaunch(
  unit: Pick<Unit, 'workerType' | 'workerModel' | 'workerExtraArgs'>,
  agentSessionId: string | null,
  strategies: ISessionStrategyFactory,
): WorkerLaunch | null {
  const base = buildWorkerLaunch(unit.workerType, unit.workerModel, unit.workerExtraArgs);
  if (!base) return null;
  if (!agentSessionId) return base;
  const strategy = strategies.create(unit.workerType);
  return strategy.supportsSession ? withFlags(base, strategy.buildResumeArgs(agentSessionId)) : base;
}
