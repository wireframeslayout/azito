import { HUB_SERVICE, runCommand, type ServiceManager } from '../modules/system/serviceManager';
import { createServiceManager, type ServiceHost } from '../modules/system/createServiceManager';
import { createHubLock, underHubLock } from '../modules/system/hubLock';
import { describeHubLauncherState, readHubLauncherState } from '../modules/system/hubLauncherState';
import { installWindowsTask, resolveWindowsHub, runOnWindows, taskExists, type ServiceCommandContext, type WindowsHub } from '../modules/system/windowsHubOperations';

const USAGE = `Usage: azito service <command>

Commands (the hub's own service: systemd on Linux, launchd on macOS, a Task Scheduler task on Windows):
  status    Show whether the service is installed and running (launchd: and which domain it is loaded into; Windows: and where its log is)
  start     Start the service
  stop      Stop the service
  restart   Restart the service
  reload    Make it run its current definition (systemd: daemon-reload + restart; launchd: bootout + bootstrap into the same domain)
  install   Windows only: register the Task Scheduler task (it starts at your logon; --yes replaces a task registered for another install). Linux and macOS: install.sh sets the service up`;

const COMMANDS = ['status', 'start', 'stop', 'restart', 'reload', 'install'] as const;
type ServiceCommand = typeof COMMANDS[number];

function isServiceCommand(value: string | undefined): value is ServiceCommand {
  return COMMANDS.some((command) => command === value);
}

export type { ServiceCommandContext };

/** The launcher restarts a hub that died; the task's own Last Result never shows it, so `status` does. A record that cannot be read is said, not skipped. */
function printLauncherState(windowsHub: WindowsHub, running: boolean): void {
  try {
    const state = readHubLauncherState(windowsHub.layout.launcherState);
    if (state) console.log(`launcher:  ${describeHubLauncherState(state)}${running ? '' : ' [the last run; the service is stopped]'}`);
  } catch (err) {
    console.log(`launcher:  cannot read ${windowsHub.layout.launcherState}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function printStatus(manager: ServiceManager, windowsHub: WindowsHub | undefined): Promise<void> {
  if (!manager.isInstalled()) {
    console.log('service:   not installed');
    return;
  }
  const { state, domains } = await manager.inspect();
  console.log(`service:   ${manager.kind} (${state})`);
  if (windowsHub) {
    console.log(`log:       ${windowsHub.layout.logFile}`);
    printLauncherState(windowsHub, state === 'active');
    // The definition copy outlives a task that was deleted by hand.
    if (!(await taskExists(windowsHub))) console.log('warning:   the task is not registered any more (deleted?). Run `azito service install` to register it again.');
  }
  if (manager.kind !== 'launchd') return;
  console.log(`domain:    ${domains.length === 0 ? 'not loaded' : domains.join(' + ')}`);
  if (domains.length > 1) {
    console.log('warning:   loaded into both gui and user (two copies). start / restart / reload refuse until one is booted out: run `azito service stop`, then `azito service start`.');
  }
}

function notInstalledMessage(manager: ServiceManager): string {
  return `The AZITO service is not installed (no ${manager.kind === 'launchd' ? 'LaunchAgent plist' : 'systemd unit'}). Run install.sh without --no-service.`;
}

/**
 * `azito service ...`: operate the hub's own service. The CLI wrapper install.sh puts in ~/.local/bin calls this on macOS, and
 * `azito.cmd` on Windows, so the launchd handling (user/<uid>, moving older gui/<uid> installs, #366) and the Task Scheduler
 * handling are in one place, the same one the in-app update and `azito misao` use.
 */
export async function serviceCommand(argv: string[], host: ServiceHost, context: ServiceCommandContext): Promise<void> {
  const [command, ...rest] = argv;
  const yes = command === 'install' && rest.length === 1 && rest[0] === '--yes';
  if (!isServiceCommand(command) || (rest.length > 0 && !yes)) {
    console.log(USAGE);
    if (argv.length > 0) process.exitCode = 1;
    return;
  }
  try {
    const created = createServiceManager(host, HUB_SERVICE, runCommand);
    if ('error' in created) throw created.error;
    const manager = created.manager;
    const windowsHub = manager.kind === 'taskscheduler' ? resolveWindowsHub(host, context) : undefined;
    if (command === 'status') {
      await printStatus(manager, windowsHub);
      return;
    }
    if (command === 'install' && !windowsHub) {
      throw new Error('`azito service install` is for Windows. On Linux and macOS install.sh sets the service up.');
    }
    if (windowsHub) {
      // One at a time with the in-app update, which stops and starts the same task.
      const lock = createHubLock(windowsHub.layout.hubRoot, context.secretFileGuard, windowsHub.systemRoot);
      await underHubLock(lock, () => (command === 'install' ? installWindowsTask(manager, windowsHub, yes) : runOnWindows(command, manager, windowsHub, context)));
    } else {
      if (!manager.isInstalled()) throw new Error(notInstalledMessage(manager));
      if (command === 'start') await manager.start();
      else if (command === 'stop') await manager.stop();
      else if (command === 'restart') await manager.restart();
      else await manager.reload();
    }
    console.log(`service ${command}: done`);
    await printStatus(manager, windowsHub);
  } catch (err) {
    console.error(`azito service: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
