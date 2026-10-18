/**
 * Whether the misao on an agent server is an older release than the one this hub bundles, so the explicit update is
 * on offer. The daemon's own answer is not enough: an older daemon may not report its version, or its protocol may not
 * match this hub, so it cannot be connected to at all. The release the managed layout points at (`current`, from the
 * agent's `/api/misao/status`) counts too, connected or not.
 */
export function agentMisaoUpdateAvailable(input: {
  bundledVersion: string | undefined;
  daemon?: { daemonVersion?: string; detail?: string };
  /** `installedVersion` of the agent's `/api/misao/status`; undefined when the layout is absent or the status could not be read. */
  installedVersion?: string;
}): boolean {
  const { bundledVersion, daemon, installedVersion } = input;
  if (!bundledVersion) return false;
  return (daemon?.daemonVersion !== undefined && daemon.daemonVersion !== bundledVersion)
    || daemon?.detail === 'protocol_incompatible'
    || (installedVersion !== undefined && installedVersion !== bundledVersion);
}
