import { WindowsDeployError, type WindowsAgentDeployer, type WindowsDeployInput } from './WindowsAgentDeployer';

/** What the update needs from the deployer (the install's own transaction: deploy, start, commit / rollback, and the clean-up of old releases). */
export type WindowsUpdateDeployer = Pick<WindowsAgentDeployer, 'deploy' | 'start' | 'describeTask' | 'pruneOldVersions'>;

export interface WindowsUpdateDeps {
  deployer: WindowsUpdateDeployer;
  /** Resolves when the agent answers `/health` with `expectedVersion` (any answer when undefined); rejects with the reason. */
  checkHealth(expectedVersion: string | undefined): Promise<void>;
  logger: { warn(message: string): void };
}

/**
 * How the previous agent stands after a failed update that had touched the host: `answers` (put back and answering),
 * `not_answering` (put back or not, it does not answer: the host needs a person), `not_running` (it was not running before
 * the update, so nothing was started again).
 */
export type PreviousAgentState = 'answers' | 'not_answering' | 'not_running';

export interface AgentUpdateResult {
  success: boolean;
  version: string;
  error?: string;
  /** The update worked, but something is left on the host that a person should know about (e.g. an old release that is in use and could not be removed, or a `*.prev` that blocks the next update). */
  warning?: string;
  /** Set by a failed update that stopped the previous agent: whether it is back. Not set for a failure before anything was changed. */
  previousAgent?: PreviousAgentState;
}

/**
 * Updates the agent of a Windows host to `input.version` with the same transaction the install uses (`deploy`, `start`, health,
 * then `commit`; `rollback` otherwise). `input.token` is the agent's current token: the new settings carry it, so the hub's
 * stored token and the host's `agent.env` never differ. A failure at any step puts the previous release, settings and task
 * definition back and starts the previous agent again; the error says what was restored, and `previousAgent` whether that agent answers.
 *
 * Only the agent is touched: the misao daemon is its own task and keeps running (and so do its panes).
 */
export async function updateWindowsAgent(deps: WindowsUpdateDeps, input: WindowsDeployInput, port: number, logFile: string): Promise<AgentUpdateResult> {
  const { deployer } = deps;
  const { sshHost, host, version } = input;

  /** Whether the previous agent answers (when it was running), as a state and a sentence for the error. */
  const verifyPrevious = async (wasRunning: boolean, previousVersion: string | undefined): Promise<{ state: PreviousAgentState; text: string }> => {
    if (!wasRunning) return { state: 'not_running', text: 'the previous agent was not running, so it was not started' };
    return deps.checkHealth(previousVersion).then(
      () => ({ state: 'answers' as const, text: 'the previous agent answers again' }),
      (e: unknown) => ({ state: 'not_answering' as const, text: `the previous agent does NOT answer (${(e as Error).message})` }),
    );
  };

  let deployment: Awaited<ReturnType<WindowsUpdateDeployer['deploy']>>;
  try {
    deployment = await deployer.deploy(input);
  } catch (err) {
    const message = `Transfer failed: ${(err as Error).message}`;
    // The deploy undid itself; if it had stopped the previous agent, that agent is checked like after any other failure.
    if (err instanceof WindowsDeployError && err.stopped !== undefined) {
      const previous = await verifyPrevious(err.stopped.wasRunning, err.stopped.version);
      return { success: false, version, error: `${message}. ${previous.text}`, previousAgent: previous.state };
    }
    return { success: false, version, error: message };
  }

  /** Puts the previous agent back and checks that it answers; the returned text is part of the error. */
  const restore = async (): Promise<{ text: string; previousAgent: PreviousAgentState }> => {
    const restored = await deployment.rollback().catch((e: unknown) => `the previous install could not be restored: ${(e as Error).message}`);
    const previous = await verifyPrevious(deployment.previousWasRunning, deployment.previousVersion);
    return { text: `Rolled back: ${restored}. ${previous.text}`, previousAgent: previous.state };
  };
  const failed = async (message: string): Promise<AgentUpdateResult> => {
    const back = await restore();
    return { success: false, version, error: `${message}. ${back.text}`, previousAgent: back.previousAgent };
  };

  try {
    await deployer.start(sshHost, host);
  } catch (err) {
    return failed(`Start failed: ${(err as Error).message}`);
  }

  try {
    await deps.checkHealth(version);
  } catch (err) {
    const taskState = await deployer.describeTask(sshHost, host);
    return failed(`Health check failed: ${(err as Error).message}. ${taskState}. The agent's log is ${logFile} (port ${port})`);
  }

  let warning = await deployment.commit().then(() => '', (e: unknown) => ` The previous install could not be removed (${(e as Error).message}); the next install on this host stops while a *.prev in the agent folder exists: delete it by hand.`);
  if (warning) deps.logger.warn(`[agent-update] ${sshHost}:${warning}`);
  warning += await pruneOldReleases(deps, input, deployment.previousVersion);
  return { success: true, version, ...(warning ? { warning: warning.trim() } : {}) };
}

/** Removes the releases older than the previous one. Returns the sentence for what stayed (empty when nothing did). */
async function pruneOldReleases(deps: WindowsUpdateDeps, input: WindowsDeployInput, previousVersion: string | undefined): Promise<string> {
  if (previousVersion === undefined) return ' The previous release is not known, so no old release was removed.';
  try {
    const result = await deps.deployer.pruneOldVersions(input.sshHost, input.host, [input.version, previousVersion]);
    if (result.failed.length === 0) return '';
    const text = ` Old releases left in place (tried again at the next update): ${result.failed.map((f) => `${f.version} (${f.reason})`).join('; ')}.`;
    deps.logger.warn(`[agent-update] ${input.sshHost}:${text}`);
    return text;
  } catch (err) {
    const text = ` Old releases could not be removed (${(err as Error).message}).`;
    deps.logger.warn(`[agent-update] ${input.sshHost}:${text}`);
    return text;
  }
}
