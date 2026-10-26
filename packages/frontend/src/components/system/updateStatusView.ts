import type { SystemUpdateStatus, UpdateStatusResponse } from '../../hooks/useSystemUpdate';

export const STATUS_LABEL_KEYS: Record<SystemUpdateStatus, string> = {
  'up-to-date': 'system.statusUpToDate',
  'checking': 'system.statusChecking',
  'update-available': 'system.statusUpdateAvailable',
  'check-failed': 'system.statusCheckFailed',
  'no-asset': 'system.statusNoAsset',
  'confirming': 'system.statusConfirming',
  'running': 'system.statusRunning',
  'restarting': 'system.statusRestarting',
  'success': 'system.statusSuccess',
  'failed': 'system.statusFailed',
  'disabled': 'system.statusDisabled',
  'blocked': 'system.statusBlocked',
};

/** The chip text: the translated label, or the status name itself when the hub reports one this build does not know (a newer hub), so the chip is never empty. */
export function updateStatusLabel(status: string, translate: (key: string) => string): string {
  const key = (STATUS_LABEL_KEYS as Record<string, string | undefined>)[status];
  return key === undefined ? status : translate(key);
}

export type UpdateStatusTone = 'green' | 'accent' | 'red' | 'orange' | 'default';

export function updateStatusTone(status: SystemUpdateStatus): UpdateStatusTone {
  if (status === 'up-to-date' || status === 'success') return 'green';
  if (status === 'update-available') return 'accent';
  if (status === 'check-failed' || status === 'failed') return 'red';
  if (status === 'no-asset') return 'orange';
  return 'default';
}

/** The sentence under the status chip for a check that did not end in "up to date" / "update available". `danger`: the check itself failed; `warning`: it worked, but there is nothing this host can install. */
export interface UpdateStatusNotice {
  severity: 'danger' | 'warning';
  key: string;
  values: Record<string, string>;
}

export function updateStatusNotice(status: Pick<UpdateStatusResponse, 'status' | 'latestVersion' | 'missingAsset'>): UpdateStatusNotice | null {
  if (status.status === 'check-failed') return { severity: 'danger', key: 'system.checkFailedDetail', values: {} };
  if (status.status === 'no-asset') {
    if (status.latestVersion === null || status.missingAsset === null) {
      throw new Error('a no-asset update status must carry latestVersion and missingAsset');
    }
    return { severity: 'warning', key: 'system.noAssetDetail', values: { version: status.latestVersion, asset: status.missingAsset } };
  }
  return null;
}
