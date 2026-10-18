import fs from 'fs';
import path from 'path';
import type { AgentMisaoHost, MisaoSocketStatus } from '../../servers/transport/agentMisaoSocket';
import { agentMisaoManagedSocket, agentMisaoRoot, MISAO_RELEASE_FILE_NAMES } from '../../servers/transport/agentMisaoSocket';
import type { AgentTransport } from '../../servers/transport/AgentTransport';
import { shellQuote } from '../../../shared/shellQuote';
import type { MisaoBundle, MisaoTargetFiles } from './MisaoBundle';
import { bundleFilesFor, sha256Buffer } from './MisaoBundle';
import { MisaoServiceError } from './MisaoServiceError';
import { MISAO_SYSTEMD_UNIT } from './misaoPaths';
import { renderMisaoUnit } from './misaoUnit';

/** What the installer needs of an agent: its shell, what it sees on disk, and a place to put release files. */
export type MisaoInstallTarget = Pick<AgentTransport, 'exec' | 'fetchMisaoStatus' | 'uploadMisaoFile'>;

export type MisaoAgentStartMethod = 'systemd' | 'nohup' | 'running';

/** What the installer is doing, in order. A code (not a sentence) so each reader can say it in its own language. `stop` is only part of an update. */
export type MisaoInstallStep = 'inspect' | 'transfer' | 'prepare' | 'stop' | 'start';

export interface MisaoAgentInstallResult {
  /** The release this install put on the host (the bundled one). */
  version: string;
  /** The release the daemon runs: the one that was already running, when it is not the bundled one. */
  runningVersion: string;
  startMethod: MisaoAgentStartMethod;
  /** A daemon of an older release was running and is left alone: switching it closes every pane (an explicit update). */
  updateAvailable: boolean;
}

export interface MisaoAgentInstallerOptions {
  /** How long a started daemon gets to open its socket (and a stopped one to close it). */
  readyTimeoutMs?: number;
  /** Pause between two socket checks. */
  pollIntervalMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const EXEC_TIMEOUT_MS = 60_000;

/** The unit file is written with these characters in paths and values; whatever else is in a path is refused instead of escaped. */
const SAFE_ABSOLUTE_PATH = /^\/[A-Za-z0-9._\-/+@=:,]+$/;

const SERVICE_UNIT_FILE = `${MISAO_SYSTEMD_UNIT}.service`;

/** Exits 0 when something accepts a connection on the socket. Runs on the agent's own node. */
const PROBE_SCRIPT = "require('net').connect(process.argv[1]).once('connect',()=>process.exit(0)).once('error',()=>process.exit(1))";

/** What was on the agent before a switch: where `current` pointed and the unit file, so a failure can put both back. */
interface PreviousInstall {
  /** The target of `current` (a version name), when there was a link. */
  link?: string;
  /** The unit file as it was (Linux only), when there was one. */
  unit?: string;
}

/**
 * The agent reports its PATH for the daemon's panes, and it lands unquoted in the unit file and in a shell command: only
 * absolute, plain directories are kept (no whitespace, control characters, quotes or `$`), the rest is dropped.
 */
export function sanitizeServicePath(servicePath: string): string {
  const kept = servicePath.split(':').filter((dir) => SAFE_ABSOLUTE_PATH.test(dir) && !/(?:^|\/)\.\.(?:\/|$)/.test(dir));
  if (kept.length === 0) throw new MisaoServiceError('unsupported_host', "None of the directories in the agent's PATH can be used in a service definition.");
  return kept.join(':');
}

function assertSafePath(value: string, label: string): void {
  if (!SAFE_ABSOLUTE_PATH.test(value) || /(?:^|\/)\.\.(?:\/|$)/.test(value)) {
    throw new MisaoServiceError('unsupported_host', `The agent's ${label} is not a path misao can be installed with (absolute, plain characters only): ${value}`);
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Installs (and explicitly updates) the bundled misao on an agent server, through the agent: the binary that fits the
 * agent's OS / architecture and its licenses go over the agent's upload route (the hub's own copy, sha256-checked on
 * both ends; the agent never downloads anything), the rest is done with the agent's exec, which runs as the same user.
 * The result is the layout the hub's own service uses, under `<home>/.azito/misao/`: `<version>/` (misao, licenses),
 * `current` -> `<version>`, the socket, a systemd user unit (a plain background process when there is no user systemd,
 * and always on macOS). A host with no binary for its OS / architecture is refused.
 *
 * `install()` never stops a running daemon: an older running release is left in place (the new files are put beside it),
 * and a daemon that is not AZITO's is refused. When nothing is running, `current` is pointed at the bundled release
 * (there are no panes to lose, and the unit that starts it needs the binary layout); if that fails, the previous link
 * and unit file are put back. `update()` is the explicit switch of a running daemon (it closes every pane): stop, switch
 * `current` and the unit, start, and on any failure put the previous link and unit back and start the previous release.
 * The rules shared with the hub's installer (the unit template and how it is filled in, the bundle and its checks, the
 * error type) are the same code.
 */
export class MisaoAgentInstaller {
  constructor(
    /** Null for a hub that carries no misao (a source checkout, or a release without one). */
    private readonly bundle: MisaoBundle | null,
    private readonly options: MisaoAgentInstallerOptions = {},
  ) {}

  /** The release this hub would install, or undefined when it carries none. */
  get bundledVersion(): string | undefined {
    return this.bundle?.version;
  }

  async install(target: MisaoInstallTarget, onProgress: (step: MisaoInstallStep) => void = () => undefined): Promise<MisaoAgentInstallResult> {
    const bundle = this.requireBundle();

    onProgress('inspect');
    const status = await this.inspect(target);
    const { host } = status;
    const files = bundleFilesFor(bundle, host.platform, host.arch);
    const root = agentMisaoRoot(host.homeDir);
    const socket = this.requireManagedSocket(status, host);

    const live = await this.isListening(target, host, socket);
    if (live && !status.installedVersion) {
      throw new MisaoServiceError('custom_socket', `A misao daemon is already listening on ${socket} that AZITO did not install. It is used as it is; AZITO will not put a second one beside it.`);
    }
    if (live && status.installedVersion === bundle.version) {
      return { version: bundle.version, runningVersion: bundle.version, startMethod: 'running', updateAvailable: false };
    }

    await this.ensureVersion(target, root, bundle.version, files, onProgress);

    if (live) {
      // An older release is running. Its panes would end with it, so only an explicit update switches (like the hub's own service).
      return { version: bundle.version, runningVersion: status.installedVersion!, startMethod: 'running', updateAvailable: true };
    }

    onProgress('start');
    const previous = await this.snapshot(target, host, root);
    try {
      const startMethod = await this.switchAndStart(target, host, root, socket, bundle);
      return { version: bundle.version, runningVersion: bundle.version, startMethod, updateAvailable: false };
    } catch (err) {
      // Nothing was running, so nothing is lost; but an older install must be startable again as it was.
      if (previous.link !== undefined && previous.link !== bundle.version) {
        await this.stopDaemon(target, host, root, socket, previous).catch(() => undefined);
        await this.restore(target, host, root, previous).catch(() => undefined);
      }
      throw err;
    }
  }

  /**
   * The explicit update of an installed misao (a running older release, a Node-era 0.2.0 among them) to the bundled one. It
   * closes every pane of the server, so the caller must have asked the user. Stops the daemon, switches `current` and the
   * unit, starts the new one, and on failure puts the previous link and unit back and starts the previous release.
   */
  async update(target: MisaoInstallTarget, onProgress: (step: MisaoInstallStep) => void = () => undefined): Promise<MisaoAgentInstallResult> {
    const bundle = this.requireBundle();

    onProgress('inspect');
    const status = await this.inspect(target);
    const { host } = status;
    const files = bundleFilesFor(bundle, host.platform, host.arch);
    const root = agentMisaoRoot(host.homeDir);
    const socket = this.requireManagedSocket(status, host);
    if (!status.installedVersion) {
      throw new MisaoServiceError('not_installed', 'misao is not installed on this server by AZITO, so there is nothing to update. Install it first.');
    }

    const live = await this.isListening(target, host, socket);
    if (live && status.installedVersion === bundle.version) {
      return { version: bundle.version, runningVersion: bundle.version, startMethod: 'running', updateAvailable: false };
    }

    // The new release is complete on disk before anything is stopped: a damaged transfer leaves the daemon running.
    await this.ensureVersion(target, root, bundle.version, files, onProgress);

    const previous = await this.snapshot(target, host, root);
    if (live) {
      onProgress('stop');
      await this.stopDaemon(target, host, root, socket, previous);
    }

    onProgress('start');
    try {
      const startMethod = await this.switchAndStart(target, host, root, socket, bundle);
      return { version: bundle.version, runningVersion: bundle.version, startMethod, updateAvailable: false };
    } catch (err) {
      return this.recoverFromFailedUpdate(err, target, host, root, socket, previous, bundle.version, status.installedVersion, live);
    }
  }

  private requireBundle(): MisaoBundle {
    if (!this.bundle) throw new MisaoServiceError('not_managed', 'This hub carries no bundled misao, so it cannot install it on an agent server.');
    return this.bundle;
  }

  private requireManagedSocket(status: MisaoSocketStatus, host: AgentMisaoHost): string {
    const socket = agentMisaoManagedSocket(host.homeDir);
    if (status.socketPath !== socket) {
      throw new MisaoServiceError('custom_socket', `The agent relays to ${status.socketPath}, not the managed socket ${socket}. Installing the managed service would leave it unused; unset MISAO_SOCKET in the agent's environment first.`);
    }
    return socket;
  }

  private async inspect(target: MisaoInstallTarget): Promise<MisaoSocketStatus> {
    let status: MisaoSocketStatus;
    try {
      status = await target.fetchMisaoStatus();
    } catch (err) {
      throw new MisaoServiceError('unsupported_host', `Could not read the agent's misao status (an agent older than this hub has no such route: update the agent first): ${describeError(err)}`);
    }
    const { host } = status;
    assertSafePath(host.homeDir, 'home directory');
    return { ...status, host: { ...host, servicePath: sanitizeServicePath(host.servicePath) } };
  }

  private async run(target: MisaoInstallTarget, script: string, what: string): Promise<{ stdout: string; stderr: string; code: number }> {
    const result = await target.exec(script, EXEC_TIMEOUT_MS);
    if (result.code !== 0) {
      throw new MisaoServiceError('transfer_failed', `${what} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`);
    }
    return result;
  }

  private async isListening(target: MisaoInstallTarget, host: AgentMisaoHost, socket: string): Promise<boolean> {
    const result = await target.exec(`${shellQuote(host.nodePath)} -e ${shellQuote(PROBE_SCRIPT)} ${shellQuote(socket)}`, 10_000);
    return result.code === 0;
  }

  /** Puts the bundled release's directory on the host (transferring it unless it is already there, whole). */
  private async ensureVersion(target: MisaoInstallTarget, root: string, version: string, files: MisaoTargetFiles, onProgress: (step: MisaoInstallStep) => void): Promise<void> {
    if (await this.hasVersion(target, root, version, files)) return;
    onProgress('transfer');
    await this.transfer(target, version, files);
    onProgress('prepare');
    await this.finalize(target, root, version);
  }

  /** Every release file of the version directory on the host is there and is the bundled one: no need to transfer it again. */
  private async hasVersion(target: MisaoInstallTarget, root: string, version: string, files: MisaoTargetFiles): Promise<boolean> {
    const dir = path.join(root, version);
    const result = await target.exec(
      MISAO_RELEASE_FILE_NAMES
        .map((name) => `(sha256sum ${shellQuote(path.join(dir, name))} 2>/dev/null || shasum -a 256 ${shellQuote(path.join(dir, name))}) | awk '{print $1}'`)
        .join('\n'),
      EXEC_TIMEOUT_MS,
    );
    const expected = MISAO_RELEASE_FILE_NAMES.map((name) => files.sha256[name]);
    return result.code === 0 && result.stdout.trim().split('\n').map((line) => line.trim()).join('\n') === expected.join('\n');
  }

  private async transfer(target: MisaoInstallTarget, version: string, files: MisaoTargetFiles): Promise<void> {
    for (const name of MISAO_RELEASE_FILE_NAMES) {
      const data = fs.readFileSync(files.files[name]);
      // The bundle was verified when it was read; this also catches a file changed on disk since.
      if (sha256Buffer(data) !== files.sha256[name]) {
        throw new MisaoServiceError('transfer_failed', `The bundled ${name} no longer matches its manifest sha256; not sending it.`);
      }
      let received: { size: number; sha256: string };
      try {
        received = await target.uploadMisaoFile(version, name, data);
      } catch (err) {
        throw new MisaoServiceError('transfer_failed', `Sending ${name} to the agent failed: ${describeError(err)}`);
      }
      if (received.sha256 !== files.sha256[name] || received.size !== data.length) {
        throw new MisaoServiceError('transfer_failed', `${name} arrived damaged: expected ${files.sha256[name]} (${data.length} bytes), the agent received ${received.sha256} (${received.size} bytes).`);
      }
    }
  }

  /** Moves the staged release into place as `<root>/<version>`. An older release's directory is not touched. */
  private async finalize(target: MisaoInstallTarget, root: string, version: string): Promise<void> {
    const stage = path.join(root, `${version}.upload`);
    const dest = path.join(root, version);
    const script = [
      'set -e',
      ...MISAO_RELEASE_FILE_NAMES.map((name) => `[ -f ${shellQuote(path.join(stage, name))} ] || { echo 'the staged release files are missing' >&2; exit 3; }`),
      `chmod 755 ${shellQuote(path.join(stage, 'misao'))}`,
      `rm -rf ${shellQuote(dest)}`,
      `mv ${shellQuote(stage)} ${shellQuote(dest)}`,
    ].join('\n');
    await this.run(target, script, 'Preparing misao on the agent');
  }

  private unitPathOf(host: AgentMisaoHost): string {
    return path.join(host.homeDir, '.config', 'systemd', 'user', SERVICE_UNIT_FILE);
  }

  /** Where `current` points and the unit file as they are now, to put back if what follows fails. */
  private async snapshot(target: MisaoInstallTarget, host: AgentMisaoHost, root: string): Promise<PreviousInstall> {
    const previous: PreviousInstall = {};
    const link = await target.exec(`readlink ${shellQuote(path.join(root, 'current'))}`, EXEC_TIMEOUT_MS);
    if (link.code === 0 && link.stdout.trim() !== '') previous.link = path.basename(link.stdout.trim());
    if (host.platform === 'linux') {
      const unit = await target.exec(`cat ${shellQuote(this.unitPathOf(host))}`, EXEC_TIMEOUT_MS);
      if (unit.code === 0) previous.unit = unit.stdout;
    }
    return previous;
  }

  /** Puts the previous `current` link and unit file back (and tells systemd about the unit). */
  private async restore(target: MisaoInstallTarget, host: AgentMisaoHost, root: string, previous: PreviousInstall): Promise<void> {
    const lines = ['set -e'];
    if (previous.link !== undefined) lines.push(`ln -sfn ${shellQuote(previous.link)} ${shellQuote(path.join(root, 'current'))}`);
    await this.run(target, lines.join('\n'), 'Putting the previous misao release back');
    if (previous.unit !== undefined) {
      await this.writeUnitFile(target, host, previous.unit);
      await target.exec('systemctl --user daemon-reload', EXEC_TIMEOUT_MS);
    }
  }

  private async writeUnitFile(target: MisaoInstallTarget, host: AgentMisaoHost, content: string): Promise<void> {
    const unitPath = this.unitPathOf(host);
    const script = [
      'set -e',
      `mkdir -p ${shellQuote(path.dirname(unitPath))}`,
      `printf %s ${shellQuote(Buffer.from(content).toString('base64'))} | base64 -d > ${shellQuote(`${unitPath}.tmp`)}`,
      `mv ${shellQuote(`${unitPath}.tmp`)} ${shellQuote(unitPath)}`,
    ].join('\n');
    await this.run(target, script, 'Writing the misao service unit');
  }

  /** Points `current` at the bundled release, writes its unit and starts it; the daemon must be listening when this returns. */
  private async switchAndStart(target: MisaoInstallTarget, host: AgentMisaoHost, root: string, socket: string, bundle: MisaoBundle): Promise<'systemd' | 'nohup'> {
    await this.run(target, `ln -sfn ${shellQuote(bundle.version)} ${shellQuote(path.join(root, 'current'))}`, 'Switching misao to the new release on the agent');
    const startMethod = await this.start(target, host, root, socket, bundle);
    await this.waitUntilListening(target, host, socket);
    return startMethod;
  }

  private async start(target: MisaoInstallTarget, host: AgentMisaoHost, root: string, socket: string, bundle: MisaoBundle): Promise<'systemd' | 'nohup'> {
    // A systemd user unit exists only on Linux; elsewhere (macOS) the daemon runs as a background process of its own.
    const systemd = host.platform === 'linux' ? await this.startWithSystemd(target, host, root, bundle) : undefined;
    if (systemd?.code === 0) return 'systemd';

    // No usable user systemd (no user bus, or none at all, or macOS): a background process. It does not survive a reboot.
    const started = await target.exec(this.backgroundCommand(host, root, socket), EXEC_TIMEOUT_MS);
    if (started.code !== 0) {
      const reason = systemd ? `systemd said (${(systemd.stderr || systemd.stdout).trim() || `exit ${systemd.code}`}) and starting it` : 'starting it';
      throw new MisaoServiceError('daemon_not_ready', `misao could not be started: ${reason} as a background process failed (${(started.stderr || started.stdout).trim() || `exit ${started.code}`}).`);
    }
    return 'nohup';
  }

  /**
   * Starts `current` as a background process. Its environment is cleared down to what the unit gives the daemon, so nothing
   * of the agent's (its token) reaches panes. It starts what `current` holds: the binary, or the `misao.mjs` of a Node-era
   * release (only a rollback to such a release gets there).
   */
  private backgroundCommand(host: AgentMisaoHost, root: string, socket: string): string {
    const env = `env -i HOME=${shellQuote(host.homeDir)} USER="$(id -un)" LOGNAME="$(id -un)" PATH=${shellQuote(host.servicePath)} LC_CTYPE=C.UTF-8`;
    const args = `serve --socket ${shellQuote(socket)} --data ${shellQuote(root)} >> ${shellQuote(path.join(root, 'misao.log'))} 2>&1 < /dev/null &`;
    const binary = path.join(root, 'current', 'misao');
    const legacy = path.join(root, 'current', 'misao.mjs');
    return [
      `cd ${shellQuote(host.homeDir)}`,
      `systemctl --user disable ${MISAO_SYSTEMD_UNIT} >/dev/null 2>&1 || true`,
      'S=; command -v setsid >/dev/null 2>&1 && S=setsid',
      `if [ -x ${shellQuote(binary)} ]; then`,
      `  $S nohup ${env} ${shellQuote(binary)} ${args}`,
      `elif [ -f ${shellQuote(legacy)} ]; then`,
      `  $S nohup ${env} ${shellQuote(host.nodePath)} ${shellQuote(legacy)} ${args}`,
      'else',
      "  echo 'no misao in current' >&2; exit 1",
      'fi',
    ].join('\n');
  }

  private async startWithSystemd(target: MisaoInstallTarget, host: AgentMisaoHost, root: string, bundle: MisaoBundle): Promise<{ code: number; stdout: string; stderr: string }> {
    const unit = renderMisaoUnit({
      template: fs.readFileSync(path.join(bundle.templatesDir, 'azito-misao.service'), 'utf-8'),
      manager: 'systemd',
      prefix: path.dirname(root),
      servicePath: host.servicePath,
    });
    await this.writeUnitFile(target, host, unit);

    // Lingering keeps the user manager (and so the daemon) alive after logout; best effort, like the agent's own unit.
    return target.exec([
      'systemctl --user daemon-reload',
      `systemctl --user enable ${MISAO_SYSTEMD_UNIT}`,
      '(loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true)',
      `systemctl --user start ${MISAO_SYSTEMD_UNIT}`,
    ].join(' && '), EXEC_TIMEOUT_MS);
  }

  /**
   * Stops the daemon on this server's managed socket (it closes every pane before exiting), and waits until the socket no
   * longer answers. In order, each only if the socket still answers: the systemd unit, `misao stop` of the installed
   * binary, and a SIGTERM to the processes of this user whose command line names this exact socket (a daemon started in
   * the background has no unit; the socket path is unique to AZITO's managed daemon). Throws when it still answers.
   */
  private async stopDaemon(target: MisaoInstallTarget, host: AgentMisaoHost, root: string, socket: string, previous: PreviousInstall): Promise<void> {
    const binary = path.join(root, 'current', 'misao');
    // `[-]-socket` matches `--socket` but not its own spelling, so the shell running this command is not matched.
    const pattern = `[-]-socket ${socket.replace(/[.+]/g, '\\$&')}( |$)`;
    const steps: string[] = [];
    if (host.platform === 'linux' && previous.unit !== undefined) steps.push(`systemctl --user stop ${MISAO_SYSTEMD_UNIT}`);
    steps.push(`[ -x ${shellQuote(binary)} ] && MISAO_SOCKET=${shellQuote(socket)} ${shellQuote(binary)} stop`);
    steps.push(`pkill -TERM -u "$(id -u)" -f -- ${shellQuote(pattern)}`);

    for (const step of steps) {
      await target.exec(`${step} >/dev/null 2>&1 || true`, EXEC_TIMEOUT_MS);
      if (await this.waitUntilStopped(target, host, socket)) return;
    }
    throw new MisaoServiceError('update_failed', `The misao daemon on ${socket} did not stop. Nothing was changed.`);
  }

  private async waitUntilStopped(target: MisaoInstallTarget, host: AgentMisaoHost, socket: string): Promise<boolean> {
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS) / 8;
    do {
      if (!(await this.isListening(target, host, socket))) return true;
      await new Promise((resolve) => setTimeout(resolve, this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
    } while (Date.now() < deadline);
    return !(await this.isListening(target, host, socket));
  }

  /**
   * The switch failed after the old daemon was stopped (its panes are gone). Stop whatever the new release started, put the
   * previous link and unit back, and start the previous release again; then report the failure either way: the update did not happen.
   */
  private async recoverFromFailedUpdate(cause: unknown, target: MisaoInstallTarget, host: AgentMisaoHost, root: string, socket: string, previous: PreviousInstall, bundledVersion: string, previousVersion: string, wasRunning: boolean): Promise<never> {
    const causeText = describeError(cause);
    const manual = `To restore the previous release by hand on the agent host: ln -sfn ${previousVersion} ${path.join(root, 'current')}`;
    try {
      await this.stopDaemon(target, host, root, socket, previous).catch(() => undefined);
      await this.restore(target, host, root, previous);
      if (wasRunning) {
        const viaSystemd = host.platform === 'linux' && previous.unit !== undefined
          && (await target.exec(`systemctl --user start ${MISAO_SYSTEMD_UNIT}`, EXEC_TIMEOUT_MS)).code === 0;
        if (!viaSystemd) {
          const started = await target.exec(this.backgroundCommand(host, root, socket), EXEC_TIMEOUT_MS);
          if (started.code !== 0) throw new Error((started.stderr || started.stdout).trim() || `exit ${started.code}`);
        }
        await this.waitUntilListening(target, host, socket);
      }
    } catch (restoreErr) {
      throw new MisaoServiceError('update_failed', `Updating misao to ${bundledVersion} failed (${causeText}) and restoring ${previousVersion} failed too (${describeError(restoreErr)}). misao is not running on this server and every pane has ended. ${manual}`);
    }
    throw new MisaoServiceError('update_failed', `Updating misao to ${bundledVersion} failed (${causeText}). The previous release ${previousVersion} was restored${wasRunning ? ' and started; its panes had already ended' : ''}.`);
  }

  private async waitUntilListening(target: MisaoInstallTarget, host: AgentMisaoHost, socket: string): Promise<void> {
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    while (Date.now() < deadline) {
      if (await this.isListening(target, host, socket)) return;
      await new Promise((resolve) => setTimeout(resolve, this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
    }
    throw new MisaoServiceError('daemon_not_ready', `The misao daemon was started but its socket ${socket} is not accepting connections yet. Check ${path.join(path.dirname(socket), 'misao.log')} or \`journalctl --user -u ${MISAO_SYSTEMD_UNIT}\` on the agent host.`);
  }
}
