import type { MuxDriverKind, MuxStatusItem } from '@azito/shared';
import type { IMuxTransport } from './transport/ServerTransport';
import type { ServerConfig } from './Server';
import { parseTmuxVersion } from './installStatusParsers';
import { stripTerminalArtifacts } from '../../shared/utils/stripTerminalArtifacts';

/**
 * tmux's status on a server: it runs and prints a version, or why not. Never throws: a failure is the status.
 * The version is asked of the transport's own tmux (`execMux`), which already knows the server's tmux runtime: the
 * managed binary lives under the home directory of the host the server is on, a path only that host can resolve.
 */
export async function checkTmuxStatus(transport: Pick<IMuxTransport, 'execMux'>): Promise<MuxStatusItem> {
  try {
    const result = await transport.execMux({ kind: 'tmux', args: ['-V'] });
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
