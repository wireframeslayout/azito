import readline from 'readline';
import type { MisaoServiceStatus } from '@azito/shared';
import { getBundleRoot } from '../shared/releaseInfo';
import { readMisaoBundle } from '../modules/system/misao/MisaoBundle';
import { createMisaoServiceController, runCommand } from '../modules/system/misao/MisaoServiceController';
import { MisaoServiceError, MisaoServiceService } from '../modules/system/misao/MisaoServiceService';
import { resolveInstallPrefix, resolveMisaoPaths, type MisaoPaths } from '../modules/system/misao/misaoPaths';

const USAGE = `Usage: azito misao <command> [options]

Commands:
  status    Show the misao service, the bundled release and the daemon
  install   Install the bundled misao as the azito-misao service and start it
            (a running daemon is left alone; --replace-socket overwrites a MISAO_SOCKET
            in the hub .env that points at another daemon)
  update    Switch the service to the bundled misao. Stops the daemon first:
            every running pane is closed. Asks for confirmation unless --yes
  start     Start the installed service if it is not running

Options:
  --prefix <dir>      Installation prefix (default: where this hub is installed)
  --replace-socket    install: overwrite a custom MISAO_SOCKET
  --yes               update: do not ask for confirmation`;

interface ParsedArgs {
  command: string | undefined;
  prefix: string | undefined;
  replaceSocket: boolean;
  yes: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: undefined, prefix: undefined, replaceSocket: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--prefix') {
      const value = argv[++i];
      if (!value) throw new MisaoServiceError('usage', '--prefix needs a directory');
      parsed.prefix = value;
    } else if (arg === '--replace-socket') parsed.replaceSocket = true;
    else if (arg === '--yes') parsed.yes = true;
    else if (arg.startsWith('-')) throw new MisaoServiceError('usage', `Unknown option: ${arg}`);
    else if (parsed.command === undefined) parsed.command = arg;
    else throw new MisaoServiceError('usage', `Unexpected argument: ${arg}`);
  }
  return parsed;
}

/** The path rules (absolute prefix, socket length) are the caller's input to fix, so they are usage errors here. */
function pathsOrUsageError(prefix: string): MisaoPaths {
  try {
    return resolveMisaoPaths(prefix);
  } catch (err) {
    throw new MisaoServiceError('usage', err instanceof Error ? err.message : String(err));
  }
}

function ask(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => { rl.close(); resolve(/^y/i.test(answer.trim())); });
  });
}

function printStatus(status: MisaoServiceStatus): void {
  const lines = [
    `service:   ${status.serviceInstalled ? `${status.serviceManager} (${status.serviceState ?? 'unknown'})` : 'not installed'}`,
    `bundled:   ${status.bundledVersion ?? '-'}`,
    `installed: ${status.installedVersion ?? '-'}`,
    `daemon:    ${status.daemon.reachable ? 'reachable' : 'not reachable'}${status.daemon.version ? ` (misao ${status.daemon.version})` : ''}`,
    `socket:    ${status.socketPath ?? '-'}`,
  ];
  console.log(lines.join('\n'));
  if (!status.managed) console.log(`note: this hub cannot manage the service (${status.unmanagedReason}).`);
  if (status.updateAvailable) console.log('note: the running misao is not the bundled release. `azito misao update` switches it (closes every pane).');
  if (status.needsHubRestart) console.log('note: restart the hub so it connects to the managed socket: systemctl --user restart azito (panes are not affected).');
}

/** `azito misao ...`: install, update, start and inspect the AZITO-managed misao service from the bundled hub. */
export async function misaoCommand(argv: string[]): Promise<void> {
  try {
    const args = parseArgs(argv);
    if (!args.command || !['status', 'install', 'update', 'start'].includes(args.command)) {
      console.log(USAGE);
      if (args.command) process.exitCode = 1;
      return;
    }

    const bundleRoot = getBundleRoot();
    const prefix = args.prefix ?? resolveInstallPrefix(bundleRoot);
    const service = new MisaoServiceService({
      paths: prefix ? pathsOrUsageError(prefix) : null,
      bundle: readMisaoBundle(bundleRoot),
      controller: createMisaoServiceController(process.platform, runCommand),
      env: process.env,
    });

    if (args.command === 'status') {
      printStatus(await service.status());
      return;
    }
    if (args.command === 'update' && !args.yes) {
      const confirmed = process.stdin.isTTY
        && await ask('Updating misao stops the daemon and closes every running pane. Continue?');
      if (!confirmed) {
        console.error('Not updated: confirmation is required (answer y, or pass --yes).');
        process.exitCode = 1;
        return;
      }
    }

    const status = args.command === 'install'
      ? await service.install({ replaceSocketSetting: args.replaceSocket })
      : args.command === 'update' ? await service.update() : await service.start();
    console.log(`misao ${args.command}: done`);
    printStatus(status);
  } catch (err) {
    // A refusal, or a service manager that is missing or failing: all are the operator's to fix, so print them plainly.
    console.error(`azito misao: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
