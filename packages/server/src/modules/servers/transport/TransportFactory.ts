import os from 'os';
import type { IServerTransport, IMuxTransport } from './ServerTransport';
import type { ServerConfig } from '../Server';
import { LocalTransport } from './LocalTransport';
import { AgentTransport } from './AgentTransport';
import { resolveTmuxRuntime } from './TmuxRuntime';

export class TransportFactory {
  private cache = new Map<string, IServerTransport & IMuxTransport>();

  constructor(private publicUrl: string) {}

  /** The shell/tmux transport of a server. It does not depend on the server's mux kinds: a misao window is reached through its driver. */
  getTransport(server: Pick<ServerConfig, 'name' | 'type' | 'host' | 'agentPort' | 'agentToken' | 'muxRuntime'>): IServerTransport & IMuxTransport {
    const key = `${server.type}:${server.name}`;
    const existing = this.cache.get(key);
    if (existing && server.type === 'agent') {
      const current = existing as AgentTransport;
      if (!current.matchesToken(server.agentToken!) || !current.matchesMuxRuntime(server.muxRuntime)) {
        this.cache.delete(key);
      } else {
        return existing;
      }
    } else if (existing) {
      return existing;
    }

    let transport: IServerTransport & IMuxTransport;
    if (server.type === 'local') {
      transport = new LocalTransport(resolveTmuxRuntime(server.muxRuntime, os.homedir()), this.publicUrl);
    } else if (server.type === 'agent') {
      transport = new AgentTransport(server.host!, server.agentPort!, server.agentToken!, server.muxRuntime, server.name);
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
