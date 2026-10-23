import type { IServerTransport, IMuxTransport, IHostBoundTransport } from './ServerTransport';
import type { ServerConfig } from '../Server';
import { LocalTransport } from './LocalTransport';
import { AgentTransport } from './AgentTransport';
import { resolveTmuxRuntime } from './TmuxRuntime';
import type { TaskTempFiles } from '../../../shared/os/taskTempFiles';
import { HostProfileError, type HostProfile, type HubHostProfile } from '../../../shared/os/hostProfile';

type TransportServer = Pick<ServerConfig, 'name' | 'type' | 'host' | 'agentPort' | 'agentToken' | 'muxRuntime' | 'hostProfile'>;

export class TransportFactory {
  private cache = new Map<string, IServerTransport & IMuxTransport & IHostBoundTransport>();

  /** `hubHost`: the hub's own host, resolved once at the entry point (see `resolveHubHostProfile`). */
  constructor(private publicUrl: string, private homeDir: string, private taskTempFiles: TaskTempFiles, private hubHost: HubHostProfile) {}

  /**
   * The OS / architecture of a server's host. A local server is the hub itself: it comes from the hub's HostEnv and is
   * never stored. An agent server's is the one recorded for it (null until recorded: a Unix agent from before the OS was kept).
   * A hub on an OS / architecture AZITO does not know has none (null: unknown, treated as POSIX): its own tmux and sh
   * operations keep working as before. Only what really needs the host (the hub's misao panes) refuses, with the reason.
   */
  hostProfileFor(server: Pick<ServerConfig, 'type' | 'hostProfile'>): HostProfile | null {
    if (server.type === 'local') return this.hubHost instanceof HostProfileError ? null : this.hubHost;
    return server.hostProfile;
  }

  /** The shell/tmux transport of a server. It does not depend on the server's mux kinds: a misao window is reached through its driver. */
  getTransport(server: TransportServer): IServerTransport & IMuxTransport & IHostBoundTransport {
    const key = `${server.type}:${server.name}`;
    const existing = this.cache.get(key);
    if (existing && server.type === 'agent') {
      const current = existing as AgentTransport;
      if (!current.matchesToken(server.agentToken!) || !current.matchesMuxRuntime(server.muxRuntime) || !current.matchesHostProfile(server.hostProfile)) {
        this.cache.delete(key);
      } else {
        return existing;
      }
    } else if (existing) {
      return existing;
    }

    let transport: IServerTransport & IMuxTransport & IHostBoundTransport;
    if (server.type === 'local') {
      transport = new LocalTransport(resolveTmuxRuntime(server.muxRuntime, this.homeDir), this.publicUrl, this.homeDir, this.taskTempFiles, this.hostProfileFor(server));
    } else if (server.type === 'agent') {
      transport = new AgentTransport(server.host!, server.agentPort!, server.agentToken!, server.muxRuntime, server.name, server.hostProfile);
    } else {
      throw new Error(`Unsupported server type: ${server.type}`);
    }
    this.cache.set(key, transport);
    return transport;
  }

  /** The cached AgentTransport of an agent server, for health/breaker access. */
  getAgentTransport(server: Parameters<TransportFactory['getTransport']>[0]): AgentTransport {
    if (server.type !== 'agent') throw new Error(`Server "${server.name}" is not an agent server`);
    return this.getTransport(server) as AgentTransport;
  }

  invalidate(serverName: string): void {
    for (const [key] of this.cache) {
      if (key.endsWith(`:${serverName}`)) {
        this.cache.delete(key);
      }
    }
  }
}
