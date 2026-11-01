import type { MisaoServiceState, MisaoServiceStatus, MisaoUnmanagedReason } from '@azito/shared';

/** Which controls the misao service row offers. */
export type MisaoServiceMode =
  /** This hub cannot install or update misao itself (source checkout, no bundled misao, unsupported host). */
  | 'unmanaged'
  | 'other_task'
  | 'unknown_task'
  | 'not_installed'
  | 'stopped'
  | 'running';

export function misaoServiceMode(status: MisaoServiceStatus): MisaoServiceMode {
  if (!status.managed) return 'unmanaged';
  if (status.windowsTaskOwner === 'other') return 'other_task';
  if (status.windowsTaskOwner === 'unknown') return 'unknown_task';
  if (!status.serviceInstalled) return 'not_installed';
  return status.serviceState === 'active' ? 'running' : 'stopped';
}

/** The state the service chip shows. A service the manager calls active whose daemon does not answer is a warning, not "running". */
export type MisaoServiceChipState = MisaoServiceState | 'activeUnreachable';

/** Undefined while the service is not installed (the row shows "not installed" itself). */
export function misaoServiceChipState(status: MisaoServiceStatus): MisaoServiceChipState | undefined {
  if (!status.serviceState) return undefined;
  if (status.serviceState === 'active' && !status.daemon.reachable) return 'activeUnreachable';
  return status.serviceState;
}

/** Notices for the row, most urgent first (urgent → context → detail). Each key is an i18n key under `servers:misaoService.notice`. */
export type MisaoNotice = 'duplicateLoad' | 'incompatible' | 'updateAvailable' | 'needsHubRestart' | 'customSocket';

export function misaoNotices(status: MisaoServiceStatus): MisaoNotice[] {
  const notices: MisaoNotice[] = [];
  const mode = misaoServiceMode(status);
  if (mode === 'unmanaged' || mode === 'unknown_task') return notices;
  // The task is another installation's: its daemon and versions are not this hub's, so only the hub's own setting is reported.
  if (mode === 'other_task') return status.socketSetting === 'custom' ? ['customSocket'] : notices;
  if (status.serviceDuplicateLoad) notices.push('duplicateLoad');
  if (status.daemon.detail === 'protocol_incompatible') notices.push('incompatible');
  else if (status.updateAvailable) notices.push('updateAvailable');
  if (status.needsHubRestart) notices.push('needsHubRestart');
  if (mode === 'not_installed' && status.socketSetting === 'custom') notices.push('customSocket');
  return notices;
}

/**
 * What the user has to agree to before an install, in the order the dialogs ask. The server takes one `replaceSocketSetting`
 * for both a task of another folder and a MISAO_SOCKET that points elsewhere, so each change it covers is confirmed on its own.
 */
export type MisaoInstallConsent = 'takeoverTask' | 'replaceSocket';

export function misaoInstallConsents(status: MisaoServiceStatus): MisaoInstallConsent[] {
  const consents: MisaoInstallConsent[] = [];
  if (misaoServiceMode(status) === 'other_task') consents.push('takeoverTask');
  if (status.socketSetting === 'custom') consents.push('replaceSocket');
  return consents;
}

export function misaoOtherTaskRunning(status: MisaoServiceStatus): boolean {
  return misaoServiceMode(status) === 'other_task' && status.windowsTaskRunning === true;
}

/** launchd has the service loaded into both domains: install / start / update are refused until one copy is booted out, so the buttons are off. */
export function misaoActionsBlocked(status: MisaoServiceStatus): boolean {
  return status.managed && status.serviceDuplicateLoad === true;
}

/** i18n key (under `servers:misaoService.unmanaged`) explaining why the hub does not manage misao. */
export function unmanagedReasonKey(reason: MisaoUnmanagedReason | undefined): string {
  switch (reason) {
    case 'source_install': return 'sourceInstall';
    case 'no_bundled_misao': return 'noBundledMisao';
    case 'unsupported_platform': return 'unsupportedPlatform';
    case 'invalid_prefix': return 'invalidPrefix';
    default: return 'unknown';
  }
}

/** The versions the row prints: the release bundled with this hub, and the one the daemon reports. */
export interface MisaoVersionLine {
  bundled?: string;
  running?: string;
}

export function misaoVersions(status: MisaoServiceStatus): MisaoVersionLine {
  return {
    ...(status.bundledVersion ? { bundled: status.bundledVersion } : {}),
    ...(status.daemon.version ? { running: status.daemon.version } : {}),
  };
}
