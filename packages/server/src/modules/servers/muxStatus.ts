import type { MuxDriverKind, MuxRuntime, MuxStatusItem } from '@azito/shared';
import type { IServerTransport } from './transport/ServerTransport';
import type { ServerConfig } from './Server';
import { parseTmuxVersion } from './installStatusParsers';
import { stripTerminalArtifacts } from '../../shared/utils/stripTerminalArtifacts';

/** The command that prints the tmux version for a server's tmux runtime (hub-managed binary or the system one). */
export function tmuxVersionCommand(muxRuntime: MuxRuntime): string {
  return muxRuntime === 'managed'
    ? '$HOME/.azito/tmux/bin/tmux -L azito -f $HOME/.azito/tmux/azito.conf -V'
    : 'tmux -V';
}

/** tmux's status on a server: it runs and prints a version, or why not. Never throws: a failure is the status. */
export async function checkTmuxStatus(transport: Pick<IServerTransport, 'exec'>, muxRuntime: MuxRuntime): Promise<MuxStatusItem> {
  try {
    const result = await transport.exec(tmuxVersionCommand(muxRuntime));
    const parsed = parseTmuxVersion(stripTerminalArtifacts(result.stdout), result.code);
    return parsed.installed ? { available: true, version: parsed.version } : { available: false, detail: parsed.detail };
  } catch (err) {
    return { available: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** A misao daemon check (`describeMisaoDaemon`) as a mux status entry. */
export function misaoStatusItem(daemon: { installed: boolean; daemonVersion?: string; detail?: string }): MuxStatusItem {
  return daemon.installed
    ? { available: true, ...(daemon.daemonVersion ? { version: daemon.daemonVersion } : {}) }
    : { available: false, detail: daemon.detail };
}

const MUX_LABEL: Record<MuxDriverKind, string> = { tmux: 'tmux', misao: 'misao' };

/**
 * A one-line problem for the server's default mux when it is down (the other kind is optional, so its absence is not
 * a problem). Undefined when the default mux answers.
 */
export function describeDefaultMuxProblem(server: Pick<ServerConfig, 'type' | 'defaultMux'>, mux: Partial<Record<MuxDriverKind, MuxStatusItem>>): string | undefined {
  const item = mux[server.defaultMux];
  if (!item || item.available) return undefined;
  if (server.defaultMux === 'tmux') return server.type === 'agent' ? 'tmux not found on agent server' : 'tmux not found';
  return `${MUX_LABEL[server.defaultMux]}: ${item.detail ?? 'unavailable'}`;
}
