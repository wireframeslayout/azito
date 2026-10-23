import type { HostPlatform } from '@azito/shared';

/** The OS and CPU architecture of a server's host (GET /api/servers `hostProfile`). Null / absent: not recorded. */
export interface HostProfile {
  platform: HostPlatform;
  arch: 'x64' | 'arm64';
}

/** i18n key suffix of a platform (`overview.os.<key>`). */
export type HostOsKey = 'linux' | 'macos' | 'windows';

const OS_KEY: Record<HostProfile['platform'], HostOsKey> = {
  linux: 'linux',
  darwin: 'macos',
  win32: 'windows',
};

/**
 * What to show for a server's OS: the OS name key and the architecture, or null for a host whose OS is not recorded
 * (an agent registered before it was kept: shown as unknown, never guessed). A value of another shape is also unknown.
 */
export function describeHostProfile(profile: unknown): { osKey: HostOsKey; arch: string } | null {
  if (!profile || typeof profile !== 'object') return null;
  const { platform, arch } = profile as { platform?: unknown; arch?: unknown };
  if (typeof platform !== 'string' || !Object.prototype.hasOwnProperty.call(OS_KEY, platform) || typeof arch !== 'string' || arch === '') return null;
  return { osKey: OS_KEY[platform as HostProfile['platform']], arch };
}
