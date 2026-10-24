import type { HostPlatform } from '../../shared/os/hostEnv';
import type { IServerRepository } from './Server';
import type { TransportFactory } from './transport/TransportFactory';

/**
 * The OS of the host a server name refers to, or null when no known server is named or its OS is not known yet (an agent that
 * has not reported it). For input checks that depend on the host's path rules.
 */
export function hostPlatformOfServerName(
  serverRepo: Pick<IServerRepository, 'findByName'>,
  transportFactory: Pick<TransportFactory, 'hostProfileFor'>,
  serverName: unknown,
): HostPlatform | null {
  if (typeof serverName !== 'string' || serverName === '') return null;
  const server = serverRepo.findByName(serverName);
  return server ? (transportFactory.hostProfileFor(server)?.platform ?? null) : null;
}
