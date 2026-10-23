import * as fs from 'fs';
import * as path from 'path';
import { HUB_SERVICE, runCommand, type ServiceManager } from '../modules/system/serviceManager';
import { createServiceManager, type ServiceHost } from '../modules/system/createServiceManager';
import { buildHubTaskXml, endHubProcesses, hubWindowsLayout, resolveWindowsUserId, type HubWindowsLayout } from '../modules/system/windowsHubService';
import { resolveInstallPrefix } from '../modules/system/misao/misaoPaths';
import { runCommandSpec, runHostOf } from '../shared/exec/runCommandSpec';

const USAGE = `Usage: azito service <command>

Commands (the hub's own service: systemd on Linux, launchd on macOS, a Task Scheduler task on Windows):
  status    Show whether the service is installed and running (launchd: and which domain it is loaded into; Windows: and where its log is)
  start     Start the service
  stop      Stop the service
  restart   Restart the service
  reload    Make it run its current definition (systemd: daemon-reload + restart; launchd: bootout + bootstrap into the same domain)
  install   Windows only: register the Task Scheduler task (it starts at your logon). Linux and macOS: install.sh sets the service up`;

const COMMANDS = ['status', 'start', 'stop', 'restart', 'reload', 'install'] as const;
type ServiceCommand = typeof COMMANDS[number];

function isServiceCommand(value: string | undefined): value is ServiceCommand {
  return COMMANDS.some((command) => command === value);
}

/** What the command needs from the process that runs it, resolved at the entry point (`main.ts`). */
export interface ServiceCommandContext {
  env: NodeJS.ProcessEnv;
  /** The release bundle this process runs from, or null for a source checkout. */
  bundleRoot: string | null;
  /** This process's id (the Windows stop sweep must not end the process that runs it). */
  pid: number;
}

/** Where the Windows hub of this bundle lives: its install prefix, task files and the `azito-hub.cjs` its `node.exe` names. */
interface WindowsHub {
  layout: HubWindowsLayout;
  entry: string;
}

function resolveWindowsHub(context: ServiceCommandContext): WindowsHub {
  if (!context.bundleRoot) throw new Error('This is not a release install (a source checkout has no service): there is no AZITO prefix to register.');
  const prefix = resolveInstallPrefix(context.bundleRoot);
  if (!prefix) throw new Error(`The bundle ${context.bundleRoot} is not inside <prefix>\\hub\\<version>, so the install prefix cannot be told.`);
  // The hub's command line names the file the way PowerShell resolves it (8.3 short names such as RUNNER~1 come out long), so the sweep
  // is given the real path too.
  return { layout: hubWindowsLayout(prefix), entry: fs.realpathSync.native(path.win32.join(context.bundleRoot, 'azito-hub.cjs')) };
}

async function printStatus(manager: ServiceManager, logFile: string | undefined): Promise<void> {
  if (!manager.isInstalled()) {
    console.log('service:   not installed');
    return;
  }
  const { state, domains } = await manager.inspect();
  console.log(`service:   ${manager.kind} (${state})`);
  if (logFile) console.log(`log:       ${logFile}`);
  if (manager.kind !== 'launchd') return;
  console.log(`domain:    ${domains.length === 0 ? 'not loaded' : domains.join(' + ')}`);
  if (domains.length > 1) {
    console.log('warning:   loaded into both gui and user (two copies). start / restart / reload refuse until one is booted out: run `azito service stop`, then `azito service start`.');
  }
}

function notInstalledMessage(manager: ServiceManager): string {
  if (manager.kind === 'taskscheduler') return 'The AZITO service is not installed (no Task Scheduler task). Run `azito service install`, or install.ps1 without -NoService.';
  return `The AZITO service is not installed (no ${manager.kind === 'launchd' ? 'LaunchAgent plist' : 'systemd unit'}). Run install.sh without --no-service.`;
}

/**
 * Registers the task. The definition is generated here (`buildHubTaskXml`), so install.ps1 never writes XML. Registering again with
 * the same definition does nothing; a different one replaces it unless the hub is running from the registered one (it would keep
 * running the old definition, and the new one would silently not apply until a restart), which is refused.
 */
async function installWindowsTask(manager: ServiceManager, host: ServiceHost, context: ServiceCommandContext, hub: WindowsHub): Promise<void> {
  if (!host.systemRoot) throw new Error('%SystemRoot% is not set, so schtasks.exe cannot be found');
  const xml = buildHubTaskXml({ userId: resolveWindowsUserId(context.env), systemRoot: host.systemRoot, layout: hub.layout });
  const registered = manager.readDefinition();
  if (registered === xml) {
    console.log('service install: the task is already registered with this definition');
    return;
  }
  if (registered !== undefined && (await manager.state()) === 'active') {
    throw new Error('The AZITO task is registered with a different definition (another install prefix or user) and is running. Stop it first (`azito stop`), then install again.');
  }
  await manager.install(xml);
}

/** stop, then make sure no `node.exe` of this install is left (the hub follows its parent and ends by itself; this is the safety net). */
async function stopWindowsHub(manager: ServiceManager, host: ServiceHost, context: ServiceCommandContext, hub: WindowsHub): Promise<void> {
  if (!host.systemRoot) throw new Error('%SystemRoot% is not set, so PowerShell cannot be found');
  await manager.stop();
  await endHubProcesses((spec) => runCommandSpec(spec, runHostOf(host)), host.systemRoot, hub.entry, context.pid);
}

async function runOnWindows(command: Exclude<ServiceCommand, 'status' | 'install'>, manager: ServiceManager, host: ServiceHost, context: ServiceCommandContext, hub: WindowsHub): Promise<void> {
  if (command === 'start') {
    await manager.start();
    return;
  }
  await stopWindowsHub(manager, host, context, hub);
  // restart and reload are the same here: the registered task is the installed definition, so making it current is a restart.
  if (command !== 'stop') await manager.start();
}

/**
 * `azito service ...`: operate the hub's own service. The CLI wrapper install.sh puts in ~/.local/bin calls this on macOS, and
 * `azito.cmd` on Windows, so the launchd handling (user/<uid>, moving older gui/<uid> installs, #366) and the Task Scheduler
 * handling are in one place, the same one the in-app update and `azito misao` use.
 */
export async function serviceCommand(argv: string[], host: ServiceHost, context: ServiceCommandContext): Promise<void> {
  const [command, ...rest] = argv;
  if (!isServiceCommand(command) || rest.length > 0) {
    console.log(USAGE);
    if (argv.length > 0) process.exitCode = 1;
    return;
  }
  try {
    const created = createServiceManager(host, HUB_SERVICE, runCommand);
    if ('error' in created) throw created.error;
    const manager = created.manager;
    const windowsHub = manager.kind === 'taskscheduler' ? resolveWindowsHub(context) : undefined;
    const logFile = windowsHub?.layout.logFile;
    if (command === 'status') {
      await printStatus(manager, logFile);
      return;
    }
    if (command === 'install') {
      if (!windowsHub) throw new Error('`azito service install` is for Windows. On Linux and macOS install.sh sets the service up.');
      await installWindowsTask(manager, host, context, windowsHub);
    } else {
      if (!manager.isInstalled()) throw new Error(notInstalledMessage(manager));
      if (windowsHub) await runOnWindows(command, manager, host, context, windowsHub);
      else if (command === 'start') await manager.start();
      else if (command === 'stop') await manager.stop();
      else if (command === 'restart') await manager.restart();
      else await manager.reload();
    }
    console.log(`service ${command}: done`);
    await printStatus(manager, logFile);
  } catch (err) {
    console.error(`azito service: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
