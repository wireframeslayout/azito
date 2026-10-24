import { useCallback, useMemo } from 'react';
import type { HostPathApi } from '@azito/shared';
import { useServerStatuses } from './useServerStatuses';
import { platformOfServer, serverPathApi } from '../lib/serverPath';

/**
 * The path functions for each named server's host OS, or null while that OS is not known yet (the server list has not
 * reported the server): path-dependent work waits for it instead of guessing POSIX. A listed agent with no recorded OS
 * is a Unix one (`platformOfServer`).
 *
 * The function keeps its identity until a server's OS changes, not on every 30 s refresh of the list, so callers can
 * list it in dependency arrays.
 */
export function useServerPathApi(): (serverName: string | null | undefined) => HostPathApi | null {
  const { servers } = useServerStatuses();
  const platformKey = servers.map((s) => `${s.name}=${platformOfServer(s)}`).join('\n');
  // eslint-disable-next-line react-hooks/exhaustive-deps -- platformKey carries the names and platforms, the only parts read
  const platforms = useMemo(() => new Map(servers.map((s) => [s.name, platformOfServer(s)] as const)), [platformKey]);
  return useCallback((serverName) => {
    const platform = serverName ? platforms.get(serverName) ?? null : null;
    return platform === null ? null : serverPathApi(platform);
  }, [platforms]);
}

/** The path functions for one server's host OS; null while it is not known yet. */
export function useServerPath(serverName: string | null | undefined): HostPathApi | null {
  return useServerPathApi()(serverName);
}
