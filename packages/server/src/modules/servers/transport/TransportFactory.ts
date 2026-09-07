import os from 'os';
import type { IServerTransport, IMuxTransport } from './ServerTransport';
import type { ServerConfig } from '../Server';
import { LocalTransport } from './LocalTransport';
import { AgentTransport } from './AgentTransport';
import { resolveTmuxRuntime } from './TmuxRuntime';
import { HerdrSocketClient } from '../../mux/herdr/HerdrSocketClient';

export class TransportFactory {
  private cache = new Map<string, IServerTransport & IMuxTransport>();
  private herdrSockets = new Map<string, HerdrSocketClient>();

  constructor(private publicUrl: string) {}

  getTransport(server: Pick<ServerConfig, 'name' | 'type' | 'host' | 'agentPort' | 'agentToken' | 'muxRuntime'>): IServerTransport & IMuxTransport {
    const key = `${server.type}:${server.name}`;
    const existing = this.cache.get(key);
    if (existing && server.type === 'agent') {
      const current = existing as AgentTransport;
      if (!current.matchesToken(server.agentToken!)) {
        this.cache.delete(key);
      } else {
        return existing;
      }
    } else if (existing) {
      return existing;
    }

    let transport: IServerTransport & IMuxTransport;
    if (server.type === 'local') {
      let herdrSocket: HerdrSocketClient | undefined;
      if (server.muxRuntime === 'herdr') {
        const sessionName = 'azito';
        herdrSocket = this.herdrSockets.get(sessionName);
        if (!herdrSocket) {
          herdrSocket = new HerdrSocketClient(sessionName);
          this.herdrSockets.set(sessionName, herdrSocket);
        }
      }
      const tmuxRuntime = (server.muxRuntime === 'herdr' || server.muxRuntime === 'zellij') ? 'system' as const : server.muxRuntime;
      transport = new LocalTransport(resolveTmuxRuntime(tmuxRuntime, os.homedir()), this.publicUrl, herdrSocket);
    } else if (server.type === 'agent') {
      transport = new AgentTransport(server.host!, server.agentPort!, server.agentToken!, server.muxRuntime);
    } else {
      throw new Error(`Unsupported server type: ${server.type}`);
    }
    this.cache.set(key, transport);
    return transport;
  }

  invalidate(serverName: string): void {
    for (const [key] of this.cache) {
      if (key.endsWith(`:${serverName}`)) {
        this.cache.delete(key);
      }
    }
  }
}
