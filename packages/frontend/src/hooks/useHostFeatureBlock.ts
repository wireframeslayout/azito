import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { HostFeature } from '@azito/shared';
import { useServerStatuses } from './useServerStatuses';
import { hostFeatureBlockReason } from '../lib/hostFeature';

/**
 * Why `feature` is closed on the named server's host, or null when it is open (or the server is not known: the hub then
 * answers for itself, and its `unsupported_os` reason is shown as it is). Entry points call this to disable themselves
 * with the reason as the tooltip / inline note.
 */
export function useHostFeatureBlock(): (serverName: string | null | undefined, feature: HostFeature) => string | null {
  const { servers } = useServerStatuses();
  const { t } = useTranslation('common');
  return useCallback((serverName, feature) => {
    if (!serverName) return null;
    const server = servers.find((s) => s.name === serverName);
    return server ? hostFeatureBlockReason(server.hostProfile, feature, t) : null;
  }, [servers, t]);
}
