import { useCallback } from 'react';
import type { HostPathApi } from '@azito/shared';
import { useServerStatuses } from './useServerStatuses';
import { serverPathApi } from '../lib/serverPath';

/** The path functions for each named server's host OS (see `serverPathApi`); an unknown server gets POSIX rules. */
export function useServerPathApi(): (serverName: string | null | undefined) => HostPathApi {
  const { servers } = useServerStatuses();
  // Stable between server-list changes: callers list it in dependency arrays.
  return useCallback((serverName) => serverPathApi(servers.find((s) => s.name === serverName)?.hostProfile), [servers]);
}

/** The path functions for one server's host OS. */
export function useServerPath(serverName: string | null | undefined): HostPathApi {
  return useServerPathApi()(serverName);
}
