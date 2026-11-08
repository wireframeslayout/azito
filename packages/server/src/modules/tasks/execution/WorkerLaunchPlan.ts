import { randomUUID } from 'crypto';
import type { Unit } from '../../units/Unit';
import { buildWorkerLaunch } from '../../agents/LaunchCommand';
import type { ISessionStrategy, ISessionStrategyFactory } from '../../agents/SessionStrategy';
import { withFlags, type WorkerLaunch } from '../../agents/WorkerLaunch';
import { buildClaudeAttachLaunch } from '../../agents/claude/launchCommand';
import { DaemonSessionChecker } from '../../agents/claude/DaemonSessionChecker';
import { workerStartsAsProgram } from '../../../shared/os/hostFeature';
import type { ServerConfig } from '../../servers/Server';

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

/** The daemon-aware resume launch, plus why the daemon check could not be asked when it could not (#639; empty otherwise). */
export interface ResumeWorkerLaunchPlan {
  launch: WorkerLaunch;
  daemonCheckUnknownReason: string;
}

/**
 * The resume launch that also knows whether the Claude Code daemon holds the conversation (#639): one it holds is
 * opened with `claude attach <id>` as the daemon's client — `--resume` of it is refused — and everything else keeps
 * the resume arguments as before. Asked only for claude (`conversationLogAgentType`): Codex has no daemon to hold a
 * conversation. When the check cannot be asked (an old CLI, a failed one — the two features entered Claude Code
 * together, so an old CLI cannot hold a daemon conversation either) the launch is the plain resume one and the reason
 * travels out for the caller to log; the answer is never swallowed. A win32 host skips the check deliberately (an npm
 * claude there is a .cmd shim the CommandSpec cannot spawn — the check would only ever answer unknown and log noise on
 * every recovery); a native claude.exe on PATH would be askable, but that is unconfirmed, so win32 keeps the plain
 * resume for now.
 *
 * `claudeConfigDir` is the conversation's own config directory when the caller knows one AND recorded it explicitly:
 * the daemon registers background sessions under the config directory that started them, and a launch whose line drops
 * the dir runs its conversation under the host's default one.
 */
export async function planResumeWorkerLaunchDaemonAware(
  unit: Pick<Unit, 'workerType' | 'workerModel' | 'workerExtraArgs'>,
  agentSessionId: string | null,
  strategies: ISessionStrategyFactory,
  daemonChecker: DaemonSessionChecker,
  server: ServerConfig,
  claudeConfigDir?: string | null,
): Promise<ResumeWorkerLaunchPlan | null> {
  const base = buildWorkerLaunch(unit.workerType, unit.workerModel, unit.workerExtraArgs);
  if (!base) return null;
  if (!agentSessionId) return { launch: base, daemonCheckUnknownReason: '' };
  const strategy = strategies.create(unit.workerType);
  if (!strategy.supportsSession) return { launch: base, daemonCheckUnknownReason: '' };
  // A win32 host skips the check deliberately (see the doc comment above): a NULL hostProfile is a Unix one, as everywhere.
  if (strategy.conversationLogAgentType === 'claude' && !workerStartsAsProgram(server.hostProfile ?? null)) {
    const verdict = await daemonChecker.check(server, agentSessionId, claudeConfigDir ?? null);
    if (verdict.status === 'attach') {
      return { launch: buildClaudeAttachLaunch(verdict.attachId), daemonCheckUnknownReason: '' };
    }
    if (verdict.status === 'unknown') {
      return { launch: withFlags(base, strategy.buildResumeArgs(agentSessionId)), daemonCheckUnknownReason: verdict.reason };
    }
  }
  return { launch: withFlags(base, strategy.buildResumeArgs(agentSessionId)), daemonCheckUnknownReason: '' };
}
