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

/** What the installer is doing, in order. A code (not a sentence) so each reader can say it in its own language. */
export type MisaoInstallStep = 'inspect' | 'transfer' | 'prepare' | 'start';

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

/**
 * Installs the bundled misao on an agent server, through the agent: the binary that fits the agent's OS / architecture
 * (the agent can differ from the hub) and its licenses go over the agent's upload route (the hub's own copy,
 * sha256-checked on both ends; the agent never downloads anything), the rest is done with the agent's exec, which runs
 * as the same user. The result is the layout the hub's own service uses, under `<home>/.azito/misao/`:
 * `<version>/` (misao, licenses), `current` -> `<version>`, the socket, a systemd user unit (a plain background process
 * when there is no user systemd, and always on macOS). A host with no binary for its OS / architecture is refused.
 *
 * Like the hub's service it never stops a running daemon: an older running release is left in place (the new files
 * are put beside it), and a daemon that is not AZITO's is refused. When nothing is running, `current` is pointed at the
 * bundled release: there are no panes to lose, and the unit that starts it needs a release in the binary layout. The rules shared with the hub's installer (the unit
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

  async install(target: MisaoInstallTarget, onProgress: (step: MisaoInstallStep) => void = () => undefined): Promise<MisaoAgentInstallResult> {
    const bundle = this.requireBundle();

    onProgress('inspect');
    const status = await this.inspect(target);
    const { host } = status;
    const files = bundleFilesFor(bundle, host.platform, host.arch);
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

    if (!(await this.hasVersion(target, root, bundle.version, files))) {
      onProgress('transfer');
      await this.transfer(target, bundle.version, files);
      onProgress('prepare');
      await this.finalize(target, root, bundle.version);
    }

    if (live) {
      // An older release is running. Its panes would end with it, so only an explicit update switches (like the hub's own service).
      return { version: bundle.version, runningVersion: status.installedVersion!, startMethod: 'running', updateAvailable: true };
    }

    onProgress('start');
    await this.pointCurrentAt(target, root, bundle.version);
    const startMethod = await this.start(target, host, root, socket, bundle);
    await this.waitUntilListening(target, host, socket);
    return { version: bundle.version, runningVersion: bundle.version, startMethod, updateAvailable: false };
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

  /** The version directory already on the host holds the bundled binary for this host, whole: no need to transfer it again. */
  private async hasVersion(target: MisaoInstallTarget, root: string, version: string, files: MisaoTargetFiles): Promise<boolean> {
    const binary = path.join(root, version, 'misao');
    const result = await target.exec(
      `(sha256sum ${shellQuote(binary)} 2>/dev/null || shasum -a 256 ${shellQuote(binary)}) | awk '{print $1}'`,
      EXEC_TIMEOUT_MS,
    );
    return result.code === 0 && result.stdout.trim() === files.sha256.misao;
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
        throw new MisaoServiceError('transfer_failed', `Sending ${name} to the agent failed: ${err instanceof Error ? err.message : String(err)}`);
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

  /** Only called with no daemon running: points `current` at the bundled release (replacing a link to an older, e.g. Node-era, release). */
  private async pointCurrentAt(target: MisaoInstallTarget, root: string, version: string): Promise<void> {
    await this.run(target, `ln -sfn ${shellQuote(version)} ${shellQuote(path.join(root, 'current'))}`, 'Switching misao to the new release on the agent');
  }

  private async start(target: MisaoInstallTarget, host: AgentMisaoHost, root: string, socket: string, bundle: MisaoBundle): Promise<'systemd' | 'nohup'> {
    // A systemd user unit exists only on Linux; elsewhere (macOS) the daemon runs as a background process of its own.
    const systemd = host.platform === 'linux' ? await this.startWithSystemd(target, host, root, bundle) : undefined;
    if (systemd?.code === 0) return 'systemd';

    // No usable user systemd (no user bus, or none at all, or macOS): a background process. It does not survive a reboot.
    // Its environment is cleared down to what the unit gives the daemon, so nothing of the agent's (its token) reaches panes.
    const background = [
      `cd ${shellQuote(host.homeDir)}`,
      `systemctl --user disable ${MISAO_SYSTEMD_UNIT} >/dev/null 2>&1 || true`,
      'S=; command -v setsid >/dev/null 2>&1 && S=setsid',
      `$S nohup env -i HOME=${shellQuote(host.homeDir)} USER="$(id -un)" LOGNAME="$(id -un)" PATH=${shellQuote(host.servicePath)} LC_CTYPE=C.UTF-8 ${shellQuote(path.join(root, 'current', 'misao'))} serve --socket ${shellQuote(socket)} --data ${shellQuote(root)} >> ${shellQuote(path.join(root, 'misao.log'))} 2>&1 < /dev/null &`,
    ].join('\n');
    const started = await target.exec(background, EXEC_TIMEOUT_MS);
    if (started.code !== 0) {
      const reason = systemd ? `systemd said (${(systemd.stderr || systemd.stdout).trim() || `exit ${systemd.code}`}) and starting it` : 'starting it';
      throw new MisaoServiceError('daemon_not_ready', `misao could not be started: ${reason} as a background process failed (${(started.stderr || started.stdout).trim() || `exit ${started.code}`}).`);
    }
    return 'nohup';
  }

  private async startWithSystemd(target: MisaoInstallTarget, host: AgentMisaoHost, root: string, bundle: MisaoBundle): Promise<{ code: number; stdout: string; stderr: string }> {
    const unit = renderMisaoUnit({
      template: fs.readFileSync(path.join(bundle.templatesDir, 'azito-misao.service'), 'utf-8'),
      manager: 'systemd',
      prefix: path.dirname(root),
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
    return target.exec([
      'systemctl --user daemon-reload',
      `systemctl --user enable ${MISAO_SYSTEMD_UNIT}`,
      '(loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true)',
      `systemctl --user start ${MISAO_SYSTEMD_UNIT}`,
    ].join(' && '), EXEC_TIMEOUT_MS);
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
