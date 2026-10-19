import type { IServerRepository, ServerConfig } from '../Server';
import type { TransportFactory } from '../transport/TransportFactory';
import { AgentHostOutdatedError } from '../transport/agentHostProtocol';
import { toHostProfile, type HostProfile } from '../../../shared/os/hostProfile';

/**
 * Records the OS / architecture an agent reports about its own host (`GET /api/host`) on its server row. Asked when an
 * agent has just been installed or updated and when it is reached with no host recorded, never per operation: an agent's
 * OS and architecture do not change when it restarts.
 *
 * An agent without the endpoint (HTTP 404) is older than this hub: its host stays unrecorded, which is read as a Unix
 * agent from before Windows support, and its existing operations keep working. The hub remembers that for the process's
 * lifetime so a reached-but-old agent is not asked on every status poll; an update asks again.
 */
export class AgentHostRecorder {
  private readonly outdated = new Set<string>();

  constructor(
    private readonly serverRepo: Pick<IServerRepository, 'updateHostProfile'>,
    private readonly transportFactory: Pick<TransportFactory, 'getAgentTransport'>,
  ) {}

  /**
   * Asks the agent and stores the answer. Returns the recorded profile, or null when the agent cannot report one (an older
   * agent). Rejects when the agent cannot be reached, answers with an error, or runs on an OS / architecture AZITO does
   * not support (`unsupported_host`: nothing is stored).
   */
  async record(server: ServerConfig): Promise<HostProfile | null> {
    this.outdated.delete(server.name);
    try {
      const info = await this.transportFactory.getAgentTransport(server).fetchHostInfo();
      const profile = toHostProfile(info.platform, info.arch);
      this.serverRepo.updateHostProfile(server.name, profile);
      return profile;
    } catch (err) {
      if (err instanceof AgentHostOutdatedError) {
        this.outdated.add(server.name);
        return null;
      }
      throw err;
    }
  }

  /** {@link record}, but only for an agent server whose host is not recorded yet and that is not known to be too old to say. */
  async recordIfUnknown(server: ServerConfig): Promise<HostProfile | null> {
    if (server.type !== 'agent') return null;
    if (server.hostProfile) return server.hostProfile;
    if (this.outdated.has(server.name)) return null;
    return this.record(server);
  }
}
