import type { HostArch, HostEnv, HostPlatform } from './hostEnv';

/** The OS and CPU architecture of a server's host (the hub itself for a local server, the agent's host for an agent server). */
export interface HostProfile {
  platform: HostPlatform;
  arch: HostArch;
}

export type HostProfileErrorCode = 'unsupported_host' | 'unsupported_os';

/**
 * A host AZITO cannot work with. `unsupported_host`: its OS / architecture is not one AZITO knows at all (freebsd, ia32...).
 * `unsupported_os`: a known OS this operation does not support yet (e.g. a POSIX-only path on win32).
 */
export class HostProfileError extends Error {
  constructor(readonly code: HostProfileErrorCode, message: string) {
    super(message);
    this.name = 'HostProfileError';
  }
}

const HOST_PLATFORMS: readonly HostPlatform[] = ['linux', 'darwin', 'win32'];
const HOST_ARCHS: readonly HostArch[] = ['x64', 'arm64'];

/** Narrows Node's `process.platform` / `process.arch` strings to a profile. An OS / architecture AZITO does not know is `unsupported_host`: there is no fallback. */
export function toHostProfile(platform: string, arch: string): HostProfile {
  const knownPlatform = HOST_PLATFORMS.find((p) => p === platform);
  const knownArch = HOST_ARCHS.find((a) => a === arch);
  if (!knownPlatform || !knownArch) {
    throw new HostProfileError('unsupported_host', `Unsupported host ${platform}/${arch} (supported: ${HOST_PLATFORMS.join(', ')} on ${HOST_ARCHS.join(', ')}).`);
  }
  return { platform: knownPlatform, arch: knownArch };
}

/**
 * The hub's own host, resolved once at the entry point. A hub on an OS / architecture AZITO does not know is not a
 * startup failure (the process still runs: P1's rule); it is carried as the error, and what needs the host (a local
 * transport, the hub's misao panes) refuses with that reason.
 */
export type HubHostProfile = HostProfile | HostProfileError;

export function resolveHubHostProfile(env: Pick<HostEnv, 'platform' | 'arch'>): HubHostProfile {
  try {
    return toHostProfile(env.platform, env.arch);
  } catch (err) {
    if (err instanceof HostProfileError) return err;
    throw err;
  }
}

/** The hub's profile, or throws the reason the hub's host is unsupported. */
export function requireHubHostProfile(hub: HubHostProfile): HostProfile {
  if (hub instanceof HostProfileError) throw hub;
  return hub;
}

/** The command that prints a host's profile, the same text under sh, cmd and PowerShell. Its output is read by {@link parseHostProbe}. */
export const HOST_PROBE_COMMAND = `node -p "process.platform+' '+process.arch"`;

/** Reads the output of {@link HOST_PROBE_COMMAND} (`<platform> <arch>`). */
export function parseHostProbe(output: string): HostProfile {
  const parts = output.trim().split(/\s+/);
  if (parts.length !== 2) {
    throw new HostProfileError('unsupported_host', `Could not read the host OS and architecture (got: ${output.trim() || 'nothing'}).`);
  }
  return toHostProfile(parts[0], parts[1]);
}

/** `exec(command: string)` runs `/bin/sh -c`: it is POSIX-only, so a win32 host is refused (a cmd.exe would otherwise interpret the sh text). A null profile is an agent registered before the OS was recorded: a Unix one. */
export function assertPosixHost(profile: HostProfile | null, serverLabel: string): void {
  if (profile?.platform === 'win32') {
    throw new HostProfileError('unsupported_os', `exec(command: string) runs the command with /bin/sh, which ${serverLabel} (win32) does not have. This operation is not available on Windows hosts yet.`);
  }
}

/** The separator of a host's PATH. A null profile (a Unix agent registered before the OS was recorded) uses `:`. */
export function pathDelimiterFor(profile: HostProfile | null): ':' | ';' {
  return profile?.platform === 'win32' ? ';' : ':';
}
