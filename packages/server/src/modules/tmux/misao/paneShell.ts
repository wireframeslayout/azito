import type { ServerConfig } from '../../servers/Server';
import { AgentHostOutdatedError, type AgentHostInfo } from '../../servers/transport/agentHostProtocol';
import { HostProfileError, requireHubHostProfile, toHostProfile, type HubHostProfile } from '../../../shared/os/hostProfile';

/** The shell a misao pane is started with and the arguments that make it run one command. */
export interface PaneShell {
  shell: string;
  /**
   * Put between the shell and the command: `[shell, ...commandArgs, command]`. Null for a shell that cannot be handed a command
   * line safely yet (a Windows host's cmd.exe: the worker launch lines are #371): a pane with that shell can only be opened bare.
   */
  commandArgs: readonly string[] | null;
}

/** Where a node's pane shell comes from. Asked each time a pane is opened; an implementation caches what it learned. */
export type PaneShellResolver = () => Promise<PaneShell>;

/** POSIX shells (sh, bash, zsh...) run a command given after `-lc` as a login shell. */
const POSIX_COMMAND_ARGS = ['-lc'] as const;

/**
 * The hub's own misao: the hub's shell, as before. A Windows hub (PowerShell panes are not implemented) is `unsupported_os`,
 * and a hub on an unknown OS is refused with that reason: the hub's Unix shell would be passed to a host that has none.
 */
export function hubPaneShell(shell: string, hubHost: HubHostProfile): PaneShellResolver {
  return async () => {
    if (requireHubHostProfile(hubHost).platform === 'win32') throw windowsNotSupported('this hub');
    return { shell, commandArgs: POSIX_COMMAND_ARGS };
  };
}

/**
 * The pane shell of an agent server's misao: the default shell of the agent's own host, as the agent reports it
 * (`$SHELL` of the agent process, else its user's passwd login shell), not the hub's. The answer is kept once the agent has given it.
 * - A Windows host's shell is the command interpreter it reports (`%ComSpec%`, misao's own default); a pane is opened bare, and
 *   running a command in it is `unsupported_os` for now (see {@link PaneShell.commandArgs}).
 * - An agent that reports no default shell is an error that says so: there is no silent fall back to `/bin/sh`.
 * - An agent too old to report its host (no `GET /api/host`) is a Unix agent from before Windows support: it keeps getting
 *   the hub's shell, as it did before the shell was per node (a known limitation until the agent is updated).
 */
export function agentPaneShell(
  server: Pick<ServerConfig, 'name' | 'hostProfile'>,
  fetchHostInfo: () => Promise<AgentHostInfo>,
  legacyShell: PaneShellResolver,
  log: { warn(message: string): void },
): PaneShellResolver {
  let known: PaneShell | undefined;
  let warnedOutdated = false;
  return async () => {
    if (known) return known;
    let info: AgentHostInfo;
    try {
      info = await fetchHostInfo();
    } catch (err) {
      if (!(err instanceof AgentHostOutdatedError)) throw err;
      // The hub's Unix shell is never a Windows host's.
      if (server.hostProfile?.platform === 'win32') throw err;
      // Not remembered: once the agent is updated, the next pane gets its own shell.
      if (!warnedOutdated) log.warn(`[misao] agent server ${server.name} cannot report its host (agent_outdated): its panes use the hub's shell. Update the agent to use its own.`);
      warnedOutdated = true;
      try {
        return await legacyShell();
      } catch (hubErr) {
        if (!(hubErr instanceof HostProfileError)) throw hubErr;
        throw new HostProfileError(hubErr.code, `agent server ${server.name} cannot report its host (agent_outdated), so its panes would use this hub's shell, which cannot start one (${hubErr.message}). Update the agent.`);
      }
    }
    const reported = toHostProfile(info.platform, info.arch).platform;
    // An agent registered without its OS cannot be a Windows one (those always record theirs): a mismatch is not guessed at.
    if (reported === 'win32' && server.hostProfile?.platform !== 'win32') throw windowsNotSupported(`agent server ${server.name} (registered without its OS)`);
    if (info.shell === null) {
      throw new Error(reported === 'win32'
        ? `agent server ${server.name} reports no default shell (%ComSpec% is not set for the agent), so a misao pane cannot be started there.`
        : `agent server ${server.name} reports no default shell (neither SHELL nor a passwd login shell exists for the agent's user), so a misao pane cannot be started there. Set SHELL for the agent and restart it.`);
    }
    known = { shell: info.shell, commandArgs: reported === 'win32' ? null : POSIX_COMMAND_ARGS };
    return known;
  };
}

function windowsNotSupported(where: string): HostProfileError {
  return new HostProfileError('unsupported_os', `misao panes on ${where} (win32) are not supported yet.`);
}

/** Running a command in a pane needs the shell's arguments for it; a shell without them (Windows' for now) is `unsupported_os`. */
export function requireCommandArgs(paneShell: PaneShell, what: string): readonly string[] {
  if (paneShell.commandArgs === null) throw new HostProfileError('unsupported_os', `${what} is not supported on this host yet: a pane running ${paneShell.shell} cannot be handed a command line (Windows worker launch is not implemented).`);
  return paneShell.commandArgs;
}
