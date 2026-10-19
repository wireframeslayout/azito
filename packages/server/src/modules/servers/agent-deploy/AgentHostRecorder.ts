import type { IServerRepository, ServerConfig } from '../Server';
import type { TransportFactory } from '../transport/TransportFactory';
import { AgentHostOutdatedError } from '../transport/agentHostProtocol';
import { toHostProfile, type HostProfile } from '../../../shared/os/hostProfile';

/** After a failed read of an agent's host, it is not asked again for this long (status polls would otherwise retry on every tick). */
export const HOST_READ_RETRY_MS = 60_000;

/** What the stored answer and the in-memory state are tied to: a different value means another machine (or another way to reach it). */
function connectionKey(server: Pick<ServerConfig, 'type' | 'host' | 'agentPort' | 'agentToken'>): string {
  return JSON.stringify([server.type, server.host, server.agentPort, server.agentToken]);
}

interface ServerState {
  /** The connection settings this state was learned under. */
  key: string;
  /** The agent answered 404: too old to report its host. */
  outdated: boolean;
  /** A read in flight, shared by every caller for the same server. */
  inflight: Promise<HostProfile | null> | undefined;
  /** Failed reads are not retried before this time (epoch ms). */
  retryAfter: number;
  /** The last warning logged, so the same one is not repeated on every poll. */
  lastWarning: string | undefined;
}

/**
 * Records the OS / architecture an agent reports about its own host (`GET /api/host`) on its server row. Asked when an
 * agent has just been installed or updated and when it is reached with no host recorded, never per operation: an agent's
 * OS and architecture do not change when it restarts.
 *
 * An agent without the endpoint (HTTP 404) is older than this hub: its host stays unrecorded, which is read as a Unix
 * agent from before Windows support, and its existing operations keep working. That, a failure to read, and the read in
 * flight are remembered per server *and per connection settings* (type / host / port / token): when a server is pointed
 * at another address the memory is dropped, and an answer that arrives after the settings changed is discarded instead of
 * being stored on the new target.
 */
export class AgentHostRecorder {
  private readonly states = new Map<string, ServerState>();

  constructor(
    private readonly serverRepo: Pick<IServerRepository, 'updateHostProfile' | 'findByName'>,
    private readonly transportFactory: Pick<TransportFactory, 'getAgentTransport'>,
    private readonly now: () => number,
    private readonly log: { warn(message: string): void },
  ) {}

  /** The server was edited or deleted: whatever was learned about it (and any read in flight) no longer applies. */
  forget(serverName: string): void {
    this.states.delete(serverName);
  }

  /**
   * Asks the agent and stores the answer. Returns the recorded profile, or null when the agent cannot report one (an older
   * agent) or the server's connection settings changed meanwhile (the answer is discarded). Rejects when the agent cannot be
   * reached, answers with an error, or runs on an OS / architecture AZITO does not support (`unsupported_host`: nothing is stored).
   */
  async record(server: ServerConfig): Promise<HostProfile | null> {
    // A fresh generation: a read still in flight from before (e.g. to the agent as it was before an update) must neither be
    // joined nor be allowed to leave its answer (a late 404) behind.
    this.forget(server.name);
    return this.read(server, this.stateFor(server));
  }

  /**
   * {@link record}, but only for an agent server whose host is not recorded yet, that is not known to be too old to say, and
   * that is not in a retry pause. A failure is logged once (the same one is not repeated) and is not thrown: this runs on
   * a status poll and at startup, which must not fail because of it.
   */
  async recordIfUnknown(server: ServerConfig): Promise<HostProfile | null> {
    if (server.type !== 'agent') return null;
    if (server.hostProfile) return server.hostProfile;
    const state = this.stateFor(server);
    if (state.outdated) return null;
    if (state.inflight) return state.inflight.catch(() => null);
    if (this.now() < state.retryAfter) return null;
    try {
      return await this.read(server, state);
    } catch (err) {
      const message = (err as Error).message;
      if (state.lastWarning !== message) {
        state.lastWarning = message;
        this.log.warn(`Could not record the host of agent server ${server.name}: ${message}`);
      }
      return null;
    }
  }

  private stateFor(server: ServerConfig): ServerState {
    const key = connectionKey(server);
    const existing = this.states.get(server.name);
    if (existing && existing.key === key) return existing;
    const fresh: ServerState = { key, outdated: false, inflight: undefined, retryAfter: 0, lastWarning: undefined };
    this.states.set(server.name, fresh);
    return fresh;
  }

  private read(server: ServerConfig, state: ServerState): Promise<HostProfile | null> {
    if (state.inflight) return state.inflight;
    const inflight = this.fetchAndStore(server, state).finally(() => {
      if (state.inflight === inflight) state.inflight = undefined;
    });
    state.inflight = inflight;
    return inflight;
  }

  private async fetchAndStore(server: ServerConfig, state: ServerState): Promise<HostProfile | null> {
    try {
      const info = await this.transportFactory.getAgentTransport(server).fetchHostInfo();
      const profile = toHostProfile(info.platform, info.arch);
      if (!this.isCurrent(server.name, state)) return null;
      this.serverRepo.updateHostProfile(server.name, profile);
      state.retryAfter = 0;
      state.lastWarning = undefined;
      return profile;
    } catch (err) {
      if (err instanceof AgentHostOutdatedError) {
        if (this.isCurrent(server.name, state)) state.outdated = true;
        return null;
      }
      state.retryAfter = this.now() + HOST_READ_RETRY_MS;
      throw err;
    }
  }

  /** The server still exists and is still reached the way this state was learned under. */
  private isCurrent(serverName: string, state: ServerState): boolean {
    if (this.states.get(serverName) !== state) return false;
    const latest = this.serverRepo.findByName(serverName);
    return latest !== null && connectionKey(latest) === state.key;
  }
}
