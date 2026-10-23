import type { HostEnv } from '../../shared/os/hostEnv';
import { HostProfileError } from '../../shared/os/hostProfile';
import { runCommandSpec, runHostOf } from '../../shared/exec/runCommandSpec';
import { rawRunnerOf } from '../../shared/os/taskScheduler/schtasks';
import { MISAO_SERVICE } from './misao/misaoPaths';
import { DEFAULT_TASK_SCHEDULER_TIMING, createWindowsServiceManager } from './windowsServiceManager';
import { serviceManagerOfKind, type CommandRunner, type ServiceManager, type ServiceSpec } from './serviceManager';

export type ServiceManagerResult = { manager: ServiceManager } | { error: HostProfileError };

/** What `createServiceManager` reads of the host: Windows also needs the temp folder and `%SystemRoot%` (where `schtasks.exe` lives). */
export type ServiceHost = Pick<HostEnv, 'platform' | 'homeDir' | 'uid' | 'tmpDir' | 'systemRoot'>;

/**
 * The service manager of this host: systemd (Linux), launchd (macOS) or the Task Scheduler (Windows; the task is started at
 * the user's logon). Any other OS is `unsupported_host`, with the reason, never a fallback to another manager. `run` is the
 * Unix command runner; the Task Scheduler is driven through `runCommandSpec` (schtasks prints in the OEM code page, which
 * `CommandRunner`'s text output cannot give back).
 */
export function createServiceManager(host: ServiceHost, spec: ServiceSpec, run: CommandRunner): ServiceManagerResult {
  if (host.platform === 'linux') return { manager: serviceManagerOfKind('systemd', spec, run, host) };
  if (host.platform === 'darwin') return { manager: serviceManagerOfKind('launchd', spec, run, host) };
  if (host.platform === 'win32') {
    const rawRun = rawRunnerOf((command) => runCommandSpec(command, { ...runHostOf(host), rawOutput: true }));
    return { manager: createWindowsServiceManager(host, spec, rawRun, DEFAULT_TASK_SCHEDULER_TIMING) };
  }
  return { error: new HostProfileError('unsupported_host', `This host (${host.platform}) has neither systemd, launchd nor the Task Scheduler, so its service cannot be managed.`) };
}

/**
 * The service manager of the hub's own misao. On Windows the hub does not manage its misao yet (the Task Scheduler wiring of
 * the hub itself is done, misao's is #380 B3b): that stays `unsupported_os`, so the Setup row and `azito misao` say so instead of
 * writing a systemd unit for a Windows task.
 */
export function createMisaoServiceManager(host: ServiceHost, run: CommandRunner): ServiceManagerResult {
  if (host.platform === 'win32') {
    return { error: new HostProfileError('unsupported_os', 'Managing the hub\'s own misao on Windows (Task Scheduler) is not supported yet: only systemd (Linux) and launchd (macOS) are.') };
  }
  return createServiceManager(host, MISAO_SERVICE, run);
}
