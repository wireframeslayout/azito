import type { WindowsAgentDeployer, WindowsDeployInput } from './WindowsAgentDeployer';

/** What the update needs from the deployer (the install's own transaction: deploy, start, commit / rollback, and the clean-up of old releases). */
export type WindowsUpdateDeployer = Pick<WindowsAgentDeployer, 'deploy' | 'start' | 'describeTask' | 'pruneOldVersions'>;

export interface WindowsUpdateDeps {
  deployer: WindowsUpdateDeployer;
  /** Resolves when the agent answers `/health` with `expectedVersion` (any answer when undefined); rejects with the reason. */
  checkHealth(expectedVersion: string | undefined): Promise<void>;
  logger: { warn(message: string): void };
}

export interface WindowsUpdateResult {
  success: boolean;
  version: string;
  error?: string;
  /** The update is done, but something is left on the host that a person may want to know about (an old release that could not be removed). */
  warning?: string;
}

/**
 * Updates the agent of a Windows host to `input.version` with the same transaction the install uses (`deploy`, `start`, health,
 * then `commit`; `rollback` otherwise). `input.token` is the agent's current token: the new settings carry it, so the hub's
 * stored token and the host's `agent.env` never differ. A failure at any step puts the previous release, settings and task
 * definition back and starts the previous agent again; the error says what was restored and whether that agent answers.
 *
 * Only the agent is touched: the misao daemon is its own task and keeps running (and so do its panes).
 */
export async function updateWindowsAgent(deps: WindowsUpdateDeps, input: WindowsDeployInput, port: number, logFile: string): Promise<WindowsUpdateResult> {
  const { deployer } = deps;
  const { sshHost, host, version } = input;
  const failed = (error: string): WindowsUpdateResult => ({ success: false, version, error });

  let deployment: Awaited<ReturnType<WindowsUpdateDeployer['deploy']>>;
  try {
    deployment = await deployer.deploy(input);
  } catch (err) {
    return failed(`Transfer failed: ${(err as Error).message}`);
  }

  /** Puts the previous agent back and checks that it answers; the returned text is part of the error. */
  const restore = async (): Promise<string> => {
    const restored = await deployment.rollback().catch((e: unknown) => `the previous install could not be restored: ${(e as Error).message}`);
    if (!deployment.previousWasRunning) return `Rolled back: ${restored}`;
    const answers = await deps.checkHealth(deployment.previousVersion).then(() => 'the previous agent answers again', (e: unknown) => `the previous agent does NOT answer (${(e as Error).message})`);
    return `Rolled back: ${restored}. ${answers}`;
  };

  try {
    await deployer.start(sshHost, host);
  } catch (err) {
    return failed(`Start failed: ${(err as Error).message}. ${await restore()}`);
  }

  try {
    await deps.checkHealth(version);
  } catch (err) {
    const taskState = await deployer.describeTask(sshHost, host);
    return failed(`Health check failed: ${(err as Error).message}. ${taskState}. The agent's log is ${logFile} (port ${port}). ${await restore()}`);
  }

  let warning = await deployment.commit().then(() => '', (e: unknown) => ` The previous install could not be removed (${(e as Error).message}); the next install on this host stops while a *.prev in the agent folder exists: delete it by hand.`);
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
