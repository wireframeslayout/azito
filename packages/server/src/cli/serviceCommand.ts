import type { HostEnv } from '../shared/os/hostEnv';
import { HUB_SERVICE, createServiceManager, runCommand, type ServiceManager } from '../modules/system/serviceManager';

const USAGE = `Usage: azito service <command>

Commands (the hub's own service: systemd on Linux, launchd on macOS):
  status    Show whether the service is installed and running (launchd: and which domain it is loaded into)
  start     Start the service
  stop      Stop the service
  restart   Restart the service
  reload    Stop and start it again, so a changed service definition is read again`;

const COMMANDS = ['status', 'start', 'stop', 'restart', 'reload'] as const;
type ServiceCommand = typeof COMMANDS[number];

function isServiceCommand(value: string | undefined): value is ServiceCommand {
  return COMMANDS.some((command) => command === value);
}

async function printStatus(manager: ServiceManager): Promise<void> {
  if (!manager.isInstalled()) {
    console.log('service:   not installed');
    return;
  }
  console.log(`service:   ${manager.kind} (${await manager.state()})`);
  if (manager.kind === 'launchd') console.log(`domain:    ${(await manager.loadedDomain()) ?? 'not loaded'}`);
}

/**
 * `azito service ...`: operate the hub's own service. The CLI wrapper install.sh puts in ~/.local/bin calls this on macOS,
 * so the launchd domain (gui/user, #366) is chosen in one place, the same one the in-app update and `azito misao` use.
 */
export async function serviceCommand(argv: string[], host: Pick<HostEnv, 'platform' | 'homeDir'>): Promise<void> {
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
    if (command === 'status') {
      await printStatus(manager);
      return;
    }
    if (!manager.isInstalled()) {
      throw new Error(`The AZITO service is not installed (no ${manager.kind === 'launchd' ? 'LaunchAgent plist' : 'systemd unit'}). Run install.sh without --no-service.`);
    }
    if (command === 'start') await manager.start();
    else if (command === 'stop') await manager.stop();
    else if (command === 'restart') await manager.restart();
    else {
      await manager.stop();
      await manager.start();
    }
    console.log(`service ${command}: done`);
    await printStatus(manager);
  } catch (err) {
    console.error(`azito service: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
