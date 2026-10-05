import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { MisaoDaemonInfo, MisaoServiceStatus, MisaoSocketSetting, MisaoUnmanagedReason } from '@azito/shared';
import { readEnvValue, upsertEnvValue } from '../../../shared/envFile';
import { buildServicePath, versionDir, type MisaoPaths } from './misaoPaths';
import { sha256File, type MisaoBundle } from './MisaoBundle';
import type { MisaoServiceController } from './MisaoServiceController';

export type MisaoServiceErrorCode =
  | 'usage'
  | 'busy'
  | 'not_managed'
  | 'custom_socket'
  | 'not_installed'
  | 'daemon_not_ready';

/** A refusal the caller can show as is: the service operation did not (fully) happen, and why. */
export class MisaoServiceError extends Error {
  constructor(readonly code: MisaoServiceErrorCode, message: string) {
    super(message);
    this.name = 'MisaoServiceError';
  }
}

export interface MisaoServiceDeps {
  /** Null when this hub is not a release install (no prefix): a source checkout never installs a service. */
  paths: MisaoPaths | null;
  /** Why `paths` could not be resolved for a release install (a prefix too long for a unix socket); surfaced instead of failing the hub's startup. */
  pathsError?: string;
  /** Null for a hub that carries no misao (source checkout, or a release without one). */
  bundle: MisaoBundle | null;
  /** Null on a host without systemd / launchd. */
  controller: MisaoServiceController | null;
  env: NodeJS.ProcessEnv;
  homeDir?: string;
  /**
   * What the running hub knows about the daemon (its `server.info`), and the socket its driver connects to.
   * Absent in the CLI, which has no hub connection: the daemon is then judged by whether its socket accepts a connection.
   */
  hub?: { probeDaemon: () => Promise<MisaoDaemonInfo>; socketPath: string };
  /** How long a started daemon gets to open its socket. */
  readyTimeoutMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 15_000;

function isSocketListening(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const done = (ok: boolean): void => { socket.destroy(); resolve(ok); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(2_000, () => done(false));
  });
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Installs, updates and starts the AZITO-managed misao service, and reports its state.
 *
 * Stopping the daemon closes every pane it hosts, so the rules here are strict: nothing in this class runs on its own
 * (no hub start, no hub update, no status poll stops or restarts the service). Stop / switch / start happen only inside
 * `update()`, which a user triggers explicitly, and `install()` / `start()` never touch a daemon that is already running.
 */
export class MisaoServiceService {
  private busy = false;

  constructor(private readonly deps: MisaoServiceDeps) {}

  /** Only valid after `requireManaged()` (every operation that touches files starts with it). */
  private get paths(): MisaoPaths {
    if (!this.deps.paths) throw new Error('misao paths are not available for a source checkout');
    return this.deps.paths;
  }

  /** Why nothing can be installed from here, or undefined when the hub carries a misao and the host has a service manager. */
  private unmanagedReason(): MisaoUnmanagedReason | undefined {
    if (this.deps.pathsError) return 'invalid_prefix';
    if (!this.deps.paths) return 'source_install';
    if (!this.deps.bundle) return 'no_bundled_misao';
    if (!this.deps.controller) return 'unsupported_platform';
    return undefined;
  }

  private requireManaged(): { bundle: MisaoBundle; controller: MisaoServiceController } {
    const { bundle, controller } = this.deps;
    const reason = this.unmanagedReason();
    if (reason === 'invalid_prefix') throw new MisaoServiceError('not_managed', this.deps.pathsError!);
    if (reason === 'source_install') throw new MisaoServiceError('not_managed', 'This hub runs from a source checkout. It connects to MISAO_SOCKET (or the default socket) and does not install a service.');
    if (!bundle) throw new MisaoServiceError('not_managed', 'This hub carries no bundled misao, so it cannot install the service.');
    if (!controller) throw new MisaoServiceError('not_managed', 'This host has neither systemd nor launchd, so the misao service cannot be managed.');
    return { bundle, controller };
  }

  installedVersion(): string | undefined {
    if (!this.deps.paths) return undefined;
    try {
      return path.basename(fs.readlinkSync(this.paths.current));
    } catch {
      return undefined;
    }
  }

  socketSetting(): MisaoSocketSetting {
    if (!this.deps.paths) return 'unset';
    const configured = readEnvValue(this.paths.hubEnvFile, 'MISAO_SOCKET');
    if (configured === undefined || configured === '') return 'unset';
    return configured === this.paths.socket ? 'managed' : 'custom';
  }

  async status(): Promise<MisaoServiceStatus> {
    const { bundle, controller, hub } = this.deps;
    const reason = this.unmanagedReason();
    const daemon: MisaoDaemonInfo = hub
      ? await hub.probeDaemon()
      : { reachable: this.deps.paths ? await isSocketListening(this.deps.paths.socket) : false };
    const serviceInstalled = controller?.isInstalled() ?? false;
    const installedVersion = this.installedVersion();
    const socketSetting = this.socketSetting();
    const updateAvailable = !!bundle && serviceInstalled && (
      installedVersion !== bundle.version
      || (daemon.version !== undefined && daemon.version !== bundle.version)
      || daemon.detail === 'protocol_incompatible'
    );
    return {
      managed: reason === undefined,
      ...(reason ? { unmanagedReason: reason } : {}),
      ...(this.deps.pathsError ? { unmanagedDetail: this.deps.pathsError } : {}),
      ...(controller ? { serviceManager: controller.manager } : {}),
      serviceInstalled,
      ...(controller && serviceInstalled ? { serviceState: await controller.state() } : {}),
      ...(bundle ? { bundledVersion: bundle.version } : {}),
      ...(installedVersion ? { installedVersion } : {}),
      daemon,
      ...(this.deps.paths ? { socketPath: this.deps.paths.socket } : {}),
      socketSetting,
      needsHubRestart: !!hub && !!this.deps.paths && serviceInstalled && socketSetting === 'managed' && hub.socketPath !== this.deps.paths.socket,
      updateAvailable,
    };
  }

  /**
   * Sets the service up: files under `<prefix>/misao/<version>/`, the unit, MISAO_SOCKET in the hub's `.env`, and a start
   * when it is not running. Safe to repeat. An already installed older version is NOT switched (that kills the panes):
   * only `update()` does. `replaceSocketSetting` lets it overwrite a MISAO_SOCKET that points elsewhere.
   */
  install(opts: { replaceSocketSetting?: boolean } = {}): Promise<MisaoServiceStatus> {
    return this.exclusive(() => this.doInstall(opts));
  }

  private async doInstall(opts: { replaceSocketSetting?: boolean }): Promise<MisaoServiceStatus> {
    const { bundle, controller } = this.requireManaged();
    if (this.socketSetting() === 'custom' && !opts.replaceSocketSetting) {
      throw new MisaoServiceError('custom_socket', `MISAO_SOCKET in ${this.paths.hubEnvFile} points at another daemon (${readEnvValue(this.paths.hubEnvFile, 'MISAO_SOCKET')}). Installing the managed service would move the hub away from it; run \`azito misao install --replace-socket\` to do that on purpose.`);
    }

    this.ensureRootDir();
    this.extractVersion(bundle);
    if (!this.installedVersion()) this.switchCurrent(bundle.version);
    await controller.install(this.renderUnit(bundle, controller));
    upsertEnvValue(this.paths.hubEnvFile, 'MISAO_SOCKET', this.paths.socket);

    if ((await controller.state()) !== 'active') {
      await controller.start();
      await this.waitUntilListening();
    }
    return this.status();
  }

  /** Starts the installed service when it is not running. It never restarts a running daemon. */
  start(): Promise<MisaoServiceStatus> {
    return this.exclusive(() => this.doStart());
  }

  private async doStart(): Promise<MisaoServiceStatus> {
    const { controller } = this.requireManaged();
    if (!controller.isInstalled()) throw new MisaoServiceError('not_installed', 'The misao service is not installed. Run `azito misao install` first.');
    if ((await controller.state()) !== 'active') {
      await controller.start();
      await this.waitUntilListening();
    }
    return this.status();
  }

  /**
   * Switches the service to the bundled misao: stop (closing every pane), point `current` at the bundled version, start.
   * When `current` already is the bundled version nothing is switched (it only starts a stopped service).
   * The new version is unpacked before the stop, so a damaged bundle fails with the daemon still running.
   */
  update(): Promise<MisaoServiceStatus> {
    return this.exclusive(() => this.doUpdate());
  }

  private async doUpdate(): Promise<MisaoServiceStatus> {
    const { bundle, controller } = this.requireManaged();
    if (!controller.isInstalled() || !this.installedVersion()) {
      throw new MisaoServiceError('not_installed', 'The misao service is not installed. Run `azito misao install` first.');
    }

    // Already on the bundled version: nothing to switch, and stopping would close every pane for no reason.
    if (this.installedVersion() === bundle.version) return this.doStart();

    this.extractVersion(bundle);
    await controller.stop();
    this.switchCurrent(bundle.version);
    await controller.install(this.renderUnit(bundle, controller));
    await controller.start();
    await this.waitUntilListening();
    return this.status();
  }

  /** One install / start / update at a time: two of them interleaving could stop a daemon the other just started. */
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new MisaoServiceError('busy', 'Another misao service operation is still running.');
    this.busy = true;
    try {
      return await operation();
    } finally {
      this.busy = false;
    }
  }

  private ensureRootDir(): void {
    fs.mkdirSync(this.paths.root, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked by the umask and ignored for an existing directory; the daemon refuses anything but 700.
    fs.chmodSync(this.paths.root, 0o700);
  }

  private isExtracted(dir: string, bundle: MisaoBundle): boolean {
    const entry = path.join(dir, 'misao.mjs');
    return fs.existsSync(entry)
      && sha256File(entry) === bundle.files['misao.mjs']
      && fs.existsSync(path.join(dir, 'node_modules', 'node-pty', 'package.json'));
  }

  /** Unpacks the bundled misao (entry file, licenses, the hub's node-pty) into `<root>/<version>/`, atomically. */
  private extractVersion(bundle: MisaoBundle): void {
    const dest = versionDir(this.paths, bundle.version);
    if (this.isExtracted(dest, bundle)) return;

    const staging = `${dest}.tmp-${process.pid}`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(path.join(staging, 'node_modules'), { recursive: true });
    fs.copyFileSync(bundle.files['misao.mjs'], path.join(staging, 'misao.mjs'));
    fs.chmodSync(path.join(staging, 'misao.mjs'), 0o755);
    fs.copyFileSync(bundle.files['LICENSES.txt'], path.join(staging, 'LICENSES.txt'));
    fs.cpSync(bundle.nodePtyDir, path.join(staging, 'node_modules', 'node-pty'), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(staging, dest);
  }

  /** Atomic: a relative symlink is built beside `current` and renamed over it. */
  private switchCurrent(version: string): void {
    const tmp = `${this.paths.current}.tmp-${process.pid}`;
    fs.rmSync(tmp, { force: true });
    fs.symlinkSync(version, tmp);
    fs.renameSync(tmp, this.paths.current);
  }

  private renderUnit(bundle: MisaoBundle, controller: MisaoServiceController): string {
    const template = fs.readFileSync(path.join(bundle.templatesDir, controller.templateName), 'utf-8');
    const servicePath = buildServicePath(this.deps.env, this.deps.homeDir ?? os.homedir(), fs.existsSync);
    // systemd treats % as a specifier, plist is XML.
    const escapedPath = controller.manager === 'launchd' ? xmlEscape(servicePath) : servicePath.replace(/%/g, '%%');
    return template
      .replaceAll('__AZITO_PREFIX__', this.paths.prefix)
      .replaceAll('__PATH__', escapedPath);
  }

  private async waitUntilListening(): Promise<void> {
    const deadline = Date.now() + (this.deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    while (Date.now() < deadline) {
      if (await isSocketListening(this.paths.socket)) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new MisaoServiceError('daemon_not_ready', `The misao daemon was started but its socket ${this.paths.socket} is not accepting connections yet. Check the service log (${this.paths.log} or the service manager's journal).`);
  }
}
