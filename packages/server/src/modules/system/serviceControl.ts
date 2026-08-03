import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';

const execFileAsync = promisify(execFile);

/**
 * How the hub's own service is managed. This is the subset of DeployMode that
 * can actually restart the service — 'source' has no service manager, so it is
 * not representable here.
 */
export type ServiceManager = 'systemd' | 'launchd';

export const LAUNCHD_LABEL = 'com.azito.hub';
export const SYSTEMD_UNIT = 'azito';

export function isServiceManager(value: string): value is ServiceManager {
  return value === 'systemd' || value === 'launchd';
}

/**
 * The command that restarts the hub, per service manager.
 *
 * launchd has no `restart` verb: `kickstart -k` sends SIGTERM to the running
 * job and starts it again, which is the closest equivalent. The service target
 * is the per-user GUI domain, matching where install.sh loads the LaunchAgent.
 */
export function restartCommand(manager: ServiceManager): { file: string; args: string[] } {
  if (manager === 'launchd') {
    return { file: 'launchctl', args: ['kickstart', '-k', `gui/${os.userInfo().uid}/${LAUNCHD_LABEL}`] };
  }
  return { file: 'systemctl', args: ['--user', 'restart', SYSTEMD_UNIT] };
}

export async function restartService(manager: ServiceManager): Promise<void> {
  const { file, args } = restartCommand(manager);
  await execFileAsync(file, args);
}
