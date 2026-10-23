/**
 * Which features a server's host supports, decided in one place from its OS (`hostProfile.platform`).
 *
 * A feature is unavailable only where the hub answers `unsupported_os` for it (or, for tmux, where the host has no such
 * program). Each unavailable feature names the issue that brings it to Windows, so a screen can say why and when.
 * A host whose OS is not recorded (null: an agent registered before it was kept) is a Unix one: every feature is available.
 */

export type HostPlatform = 'linux' | 'darwin' | 'win32';

export interface HostPlatformInfo {
  platform: HostPlatform;
}

export type HostFeature =
  | 'files'
  | 'git'
  | 'taskExecution'
  | 'workerLaunch'
  | 'tmux'
  | 'browserRuntime'
  | 'harness';

export const HOST_FEATURES: readonly HostFeature[] = ['files', 'git', 'taskExecution', 'workerLaunch', 'tmux', 'browserRuntime', 'harness'];

export type HostFeatureSupport =
  | { available: true }
  | { available: false; /** The tracking issue that brings the feature to this OS; null when it never will (tmux on Windows). */ issue: number | null };

/** The Windows rows: feature -> the issue that supports it. `null`: not planned (the host has no such program). */
const WIN32_UNAVAILABLE: Record<HostFeature, number | null | undefined> = {
  files: 370,
  git: 370,
  taskExecution: 371,
  workerLaunch: 371,
  tmux: null,
  browserRuntime: 372,
  harness: 371,
};

export function hostFeatureSupport(profile: HostPlatformInfo | null | undefined, feature: HostFeature): HostFeatureSupport {
  if (profile?.platform !== 'win32') return { available: true };
  const issue = WIN32_UNAVAILABLE[feature];
  return issue === undefined ? { available: true } : { available: false, issue };
}
