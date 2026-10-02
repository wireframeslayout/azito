import os from 'os';
import type { IServerTransport, IMuxTransport } from './ServerTransport';
import type { ServerConfig } from '../Server';
import { LocalTransport } from './LocalTransport';
import { AgentTransport } from './AgentTransport';
import { resolveTmuxRuntime } from './TmuxRuntime';
import { muxKindForRuntime } from '@azito/shared';
import { MuxDriverUnavailableError } from '../../tmux/MuxCapabilityError';

export interface TransportFactoryOptions {
  misaoEnabled?: boolean;
}

export class TransportFactory {
  private cache = new Map<string, IServerTransport & IMuxTransport>();

  private misaoEnabled: boolean;

  constructor(private publicUrl: string, options: TransportFactoryOptions = {}) {
    this.misaoEnabled = options.misaoEnabled ?? false;
  }

  getTransport(server: Pick<ServerConfig, 'name' | 'type' | 'host' | 'agentPort' | 'agentToken' | 'muxRuntime'>): IServerTransport & IMuxTransport {
    // Never fall back to a tmux transport for a non-tmux runtime; checked before the cache so a stale tmux entry is not returned.
    if (muxKindForRuntime(server.muxRuntime) !== 'tmux') {
      throw new MuxDriverUnavailableError('misao', this.misaoEnabled ? 'driver_not_registered' : 'misao_disabled');
    }
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
