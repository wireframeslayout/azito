import fs from 'fs';
import path from 'path';
import type { AgentMisaoHost, MisaoSocketStatus } from '../../servers/transport/agentMisaoSocket';
import { agentMisaoManagedSocket, agentMisaoRoot } from '../../servers/transport/agentMisaoSocket';
import type { AgentTransport } from '../../servers/transport/AgentTransport';
import { shellQuote } from '../../../shared/shellQuote';
import type { MisaoBundle } from './MisaoBundle';
import { sha256Buffer } from './MisaoBundle';
import { MisaoServiceError } from './MisaoServiceError';
import { MISAO_SYSTEMD_UNIT } from './misaoPaths';
import { renderMisaoUnit } from './misaoUnit';

/** What the installer needs of an agent: its shell, what it sees on disk, and a place to put release files. */
export type MisaoInstallTarget = Pick<AgentTransport, 'exec' | 'fetchMisaoStatus' | 'uploadMisaoFile'>;

export type MisaoAgentStartMethod = 'systemd' | 'nohup' | 'running';

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
  /** How long a started daemon gets to open its socket. */
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

function assertSafePath(value: string, label: string): void {
  if (!SAFE_ABSOLUTE_PATH.test(value) || /(?:^|\/)\.\.(?:\/|$)/.test(value)) {
    throw new MisaoServiceError('unsupported_host', `The agent's ${label} is not a path misao can be installed with (absolute, plain characters only): ${value}`);
  }
}

/**
 * Installs the bundled misao on an agent server, through the agent: release files go over the agent's upload route (the
 * hub's own copy, sha256-checked on both ends; the agent never downloads anything), the rest is done with the agent's
 * exec, which runs as the same user. The result is the layout the hub's own service uses, under `<home>/.azito/misao/`:
 * `<version>/` (misao.mjs, the agent's node-pty), `current` -> `<version>`, the socket, a systemd user unit (a plain
 * background process when there is no user systemd).
 *
 * Like the hub's service it never stops a running daemon: an older running release is left in place (the new files
 * are put beside it), and a daemon that is not AZITO's is refused. The rules shared with the hub's installer (the unit
 * template and how it is filled in, the bundle and its checks, the error type) are the same code.
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

  async install(target: MisaoInstallTarget, onProgress: (message: string) => void = () => undefined): Promise<MisaoAgentInstallResult> {
    const bundle = this.requireBundle();

    onProgress('Inspecting the agent host');
    const status = await this.inspect(target);
    const { host } = status;
    const root = agentMisaoRoot(host.homeDir);
    const socket = agentMisaoManagedSocket(host.homeDir);
    if (status.socketPath !== socket) {
      throw new MisaoServiceError('custom_socket', `The agent relays to ${status.socketPath}, not the managed socket ${socket}. Installing the managed service would leave it unused; unset MISAO_SOCKET in the agent's environment first.`);
    }

    const live = await this.isListening(target, host, socket);
    if (live && !status.installedVersion) {
      throw new MisaoServiceError('custom_socket', `A misao daemon is already listening on ${socket} that AZITO did not install. It is used as it is; AZITO will not put a second one beside it.`);
    }
    if (live && status.installedVersion === bundle.version) {
      return { version: bundle.version, runningVersion: bundle.version, startMethod: 'running', updateAvailable: false };
    }

    if (!(await this.hasVersion(target, root, bundle))) {
      onProgress('Transferring misao');
      await this.transfer(target, bundle);
      onProgress('Preparing misao');
      await this.finalize(target, host, root, bundle.version);
    }

    if (live) {
      // An older release is running. Its panes would end with it, so only an explicit update switches (like the hub's own service).
      return { version: bundle.version, runningVersion: status.installedVersion!, startMethod: 'running', updateAvailable: true };
    }

    onProgress('Starting misao');
    const startMethod = await this.start(target, host, root, socket, bundle);
    await this.waitUntilListening(target, host, socket);
    // `current` is not moved by an install, so a host that had an older release installed starts that one.
    const runningVersion = status.installedVersion ?? bundle.version;
    return { version: bundle.version, runningVersion, startMethod, updateAvailable: runningVersion !== bundle.version };
  }

  private requireBundle(): MisaoBundle {
    if (!this.bundle) throw new MisaoServiceError('not_managed', 'This hub carries no bundled misao, so it cannot install it on an agent server.');
    return this.bundle;
  }

  private async inspect(target: MisaoInstallTarget): Promise<MisaoSocketStatus> {
    let status: MisaoSocketStatus;
    try {
      status = await target.fetchMisaoStatus();
    } catch (err) {
      throw new MisaoServiceError('unsupported_host', `Could not read the agent's misao status (an agent older than this hub has no such route: update the agent first): ${err instanceof Error ? err.message : String(err)}`);
    }
    const { host } = status;
    if (host.platform !== 'linux') throw new MisaoServiceError('unsupported_host', `misao can be installed on Linux agent servers only (this one is ${host.platform}).`);
    if (host.arch !== 'x64') throw new MisaoServiceError('unsupported_host', `misao can be installed on x86_64 agent servers only (this one is ${host.arch}).`);
    assertSafePath(host.homeDir, 'home directory');
    assertSafePath(host.nodePath, 'node binary');
    if (!host.nodePtyDir) throw new MisaoServiceError('unsupported_host', "The agent has no node-pty to share with misao: reinstall the agent.");
    assertSafePath(host.nodePtyDir, 'node-pty directory');
    return status;
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

  /** The version directory already on the host is the bundled one, whole: no need to transfer it again. */
  private async hasVersion(target: MisaoInstallTarget, root: string, bundle: MisaoBundle): Promise<boolean> {
    const dir = path.join(root, bundle.version);
    const result = await target.exec([
      `[ -f ${shellQuote(path.join(dir, 'node_modules', 'node-pty', 'package.json'))} ] || exit 1`,
      `(sha256sum ${shellQuote(path.join(dir, 'misao.mjs'))} 2>/dev/null || shasum -a 256 ${shellQuote(path.join(dir, 'misao.mjs'))}) | awk '{print $1}'`,
    ].join('\n'), EXEC_TIMEOUT_MS);
    return result.code === 0 && result.stdout.trim() === bundle.sha256['misao.mjs'];
  }

  private async transfer(target: MisaoInstallTarget, bundle: MisaoBundle): Promise<void> {
    for (const name of ['misao.mjs', 'LICENSES.txt'] as const) {
      const data = fs.readFileSync(bundle.files[name]);
      // The bundle was verified when it was read; this also catches a file changed on disk since.
      if (sha256Buffer(data) !== bundle.sha256[name]) {
        throw new MisaoServiceError('transfer_failed', `The bundled ${name} no longer matches its manifest sha256; not sending it.`);
      }
      let received: { size: number; sha256: string };
      try {
        received = await target.uploadMisaoFile(bundle.version, name, data);
      } catch (err) {
        throw new MisaoServiceError('transfer_failed', `Sending ${name} to the agent failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (received.sha256 !== bundle.sha256[name] || received.size !== data.length) {
        throw new MisaoServiceError('transfer_failed', `${name} arrived damaged: expected ${bundle.sha256[name]} (${data.length} bytes), the agent received ${received.sha256} (${received.size} bytes).`);
      }
    }
  }

  /** Completes the staged release (the agent's node-pty goes beside it), moves it into place and, only when there is none, points `current` at it. */
  private async finalize(target: MisaoInstallTarget, host: AgentMisaoHost, root: string, version: string): Promise<void> {
    const stage = path.join(root, `${version}.upload`);
    const dest = path.join(root, version);
    const current = path.join(root, 'current');
    const script = [
      'set -e',
      `[ -f ${shellQuote(path.join(stage, 'misao.mjs'))} ] && [ -f ${shellQuote(path.join(stage, 'LICENSES.txt'))} ] || { echo 'the staged release files are missing' >&2; exit 3; }`,
      `mkdir -p ${shellQuote(path.join(stage, 'node_modules'))}`,
      `rm -rf ${shellQuote(path.join(stage, 'node_modules', 'node-pty'))}`,
      `cp -R ${shellQuote(host.nodePtyDir!)} ${shellQuote(path.join(stage, 'node_modules', 'node-pty'))}`,
      `[ -f ${shellQuote(path.join(stage, 'node_modules', 'node-pty', 'package.json'))} ] || { echo 'node-pty could not be copied' >&2; exit 4; }`,
      `rm -rf ${shellQuote(dest)}`,
      `mv ${shellQuote(stage)} ${shellQuote(dest)}`,
      `[ -e ${shellQuote(current)} ] || [ -L ${shellQuote(current)} ] || ln -s ${shellQuote(version)} ${shellQuote(current)}`,
    ].join('\n');
    await this.run(target, script, 'Preparing misao on the agent');
  }

  private async start(target: MisaoInstallTarget, host: AgentMisaoHost, root: string, socket: string, bundle: MisaoBundle): Promise<'systemd' | 'nohup'> {
    const template = fs.readFileSync(path.join(bundle.templatesDir, 'azito-misao.service'), 'utf-8');
    const unit = renderMisaoUnit({
      template,
      manager: 'systemd',
      prefix: path.dirname(root),
      node: host.nodePath,
      servicePath: host.servicePath,
    });
    const unitPath = path.join(host.homeDir, '.config', 'systemd', 'user', SERVICE_UNIT_FILE);
    const writeUnit = [
      'set -e',
      `mkdir -p ${shellQuote(path.dirname(unitPath))}`,
      `printf %s ${shellQuote(Buffer.from(unit).toString('base64'))} | base64 -d > ${shellQuote(`${unitPath}.tmp`)}`,
      `mv ${shellQuote(`${unitPath}.tmp`)} ${shellQuote(unitPath)}`,
    ].join('\n');
    await this.run(target, writeUnit, 'Writing the misao service unit');

    // Lingering keeps the user manager (and so the daemon) alive after logout; best effort, like the agent's own unit.
    const systemd = await target.exec([
      'systemctl --user daemon-reload',
      `systemctl --user enable ${MISAO_SYSTEMD_UNIT}`,
      '(loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true)',
      `systemctl --user start ${MISAO_SYSTEMD_UNIT}`,
    ].join(' && '), EXEC_TIMEOUT_MS);
    if (systemd.code === 0) return 'systemd';

    // No usable user systemd (no user bus, or none at all): a background process of its own. It does not survive a reboot.
    // Its environment is cleared down to what the unit gives the daemon, so nothing of the agent's (its token) reaches panes.
    const background = [
      `cd ${shellQuote(host.homeDir)}`,
      `systemctl --user disable ${MISAO_SYSTEMD_UNIT} >/dev/null 2>&1 || true`,
      'S=; command -v setsid >/dev/null 2>&1 && S=setsid',
      `$S nohup env -i HOME=${shellQuote(host.homeDir)} USER="$(id -un)" LOGNAME="$(id -un)" PATH=${shellQuote(host.servicePath)} LC_CTYPE=C.UTF-8 ${shellQuote(host.nodePath)} ${shellQuote(path.join(root, 'current', 'misao.mjs'))} serve --socket ${shellQuote(socket)} --data ${shellQuote(root)} >> ${shellQuote(path.join(root, 'misao.log'))} 2>&1 < /dev/null &`,
    ].join('\n');
    const started = await target.exec(background, EXEC_TIMEOUT_MS);
    if (started.code !== 0) {
      throw new MisaoServiceError('daemon_not_ready', `misao could not be started: systemd said (${(systemd.stderr || systemd.stdout).trim() || `exit ${systemd.code}`}) and starting it as a background process failed too (${(started.stderr || started.stdout).trim() || `exit ${started.code}`}).`);
    }
    return 'nohup';
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
