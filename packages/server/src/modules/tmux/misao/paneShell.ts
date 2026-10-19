import type { ServerConfig } from '../../servers/Server';
import { AgentHostOutdatedError, type AgentHostInfo } from '../../servers/transport/agentHostProtocol';
import { HostProfileError, toHostProfile } from '../../../shared/os/hostProfile';

/** The shell a misao pane is started with and the arguments that make it run one command. */
export interface PaneShell {
  shell: string;
  /** Put between the shell and the command: `[shell, ...commandArgs, command]`. */
  commandArgs: readonly string[];
}

/** Where a node's pane shell comes from. Asked each time a pane is opened; an implementation caches what it learned. */
export type PaneShellResolver = () => Promise<PaneShell>;

/** POSIX shells (sh, bash, zsh...) run a command given after `-lc` as a login shell. */
const POSIX_COMMAND_ARGS = ['-lc'] as const;

/** The hub's own misao: the hub's shell, as before. */
export function hubPaneShell(shell: string): PaneShellResolver {
  return () => Promise.resolve({ shell, commandArgs: POSIX_COMMAND_ARGS });
}

/**
 * The pane shell of an agent server's misao: the default shell of the agent's own host, as the agent reports it
 * (`$SHELL` of the agent process), not the hub's. The answer is kept once the agent has given it.
 * - A Windows host is `unsupported_os` (its shell, PowerShell, is started differently and is not supported yet).
 * - An agent that reports no `$SHELL` is an error that says so: there is no silent fall back to `/bin/sh`.
 * - An agent too old to report its host (no `GET /api/host`) is a Unix agent from before Windows support: it keeps getting
 *   the hub's shell, as it did before the shell was per node (a known limitation until the agent is updated).
 */
export function agentPaneShell(
  server: Pick<ServerConfig, 'name' | 'hostProfile'>,
  fetchHostInfo: () => Promise<AgentHostInfo>,
  hubShell: string,
  log: { warn(message: string): void },
): PaneShellResolver {
  let known: PaneShell | undefined;
  let warnedOutdated = false;
  return async () => {
    if (known) return known;
    if (server.hostProfile?.platform === 'win32') throw windowsNotSupported(server.name);
    let info: AgentHostInfo;
    try {
      info = await fetchHostInfo();
    } catch (err) {
      if (!(err instanceof AgentHostOutdatedError)) throw err;
      // Not remembered: once the agent is updated, the next pane gets its own shell.
      if (!warnedOutdated) log.warn(`[misao] agent server ${server.name} cannot report its host (agent_outdated): its panes use the hub's shell ${hubShell}. Update the agent to use its own.`);
      warnedOutdated = true;
      return { shell: hubShell, commandArgs: POSIX_COMMAND_ARGS };
    }
    if (toHostProfile(info.platform, info.arch).platform === 'win32') throw windowsNotSupported(server.name);
    if (info.shell === null) {
      throw new Error(`agent server ${server.name} reports no default shell (SHELL is not set in the agent process's environment), so a misao pane cannot be started there. Set SHELL for the agent and restart it.`);
    }
    known = { shell: info.shell, commandArgs: POSIX_COMMAND_ARGS };
    return known;
  };
}

function windowsNotSupported(serverName: string): HostProfileError {
  return new HostProfileError('unsupported_os', `misao panes on agent server ${serverName} (win32) are not supported yet: starting a PowerShell pane is not implemented.`);
}
