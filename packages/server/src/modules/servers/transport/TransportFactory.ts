import os from 'os';
import type { IServerTransport, IMuxTransport } from './ServerTransport';
import type { ServerConfig } from '../Server';
import { LocalTransport } from './LocalTransport';
import { AgentTransport } from './AgentTransport';
import { resolveTmuxRuntime } from './TmuxRuntime';
import { muxKindForRuntime } from '@azito/shared';
import { MuxDriverUnavailableError } from '../../tmux/MuxCapabilityError';
import type { MuxDriverAvailability } from '../../tmux/MuxDriverRegistry';
import { MuxlessLocalTransport } from './MuxlessLocalTransport';

type MuxAvailabilityFn = (server: Pick<ServerConfig, 'muxRuntime'>) => MuxDriverAvailability;

export interface TransportFactoryOptions {
  /** MuxDriverRegistry.availability; omitted means the misao flag is off. */
  muxAvailability?: MuxAvailabilityFn;
}

const MISAO_DISABLED: MuxAvailabilityFn = () => ({ available: false, reason: 'misao_disabled' });

export class TransportFactory {
  private cache = new Map<string, IServerTransport & IMuxTransport>();

  private muxAvailability: MuxAvailabilityFn;

  constructor(private publicUrl: string, options: TransportFactoryOptions = {}) {
    this.muxAvailability = options.muxAvailability ?? MISAO_DISABLED;
  }

  getTransport(server: Pick<ServerConfig, 'name' | 'type' | 'host' | 'agentPort' | 'agentToken' | 'muxRuntime'>): IServerTransport & IMuxTransport {
    // Exec is independent of the mux, so a non-tmux local server still gets a shell transport; its mux operations fail
    // via the registry's availability instead of falling back to tmux. Checked before the cache so a stale tmux entry
    // is never returned.
    const kind = muxKindForRuntime(server.muxRuntime);
    if (kind !== 'tmux') {
      if (server.type === 'local') return new MuxlessLocalTransport(kind, () => this.muxAvailability(server));
      const availability = this.muxAvailability(server);
      if (!availability.available) throw new MuxDriverUnavailableError(kind, availability.reason);
      throw new Error(`Mux kind "${kind}" is not supported on ${server.type} servers`);
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
