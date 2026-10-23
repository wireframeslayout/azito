import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import type { MisaoDaemonInfo, MisaoServiceStatus, MisaoSocketSetting, MisaoUnmanagedReason } from '@azito/shared';
import { readEnvValue, upsertEnvValue } from '../../../shared/envFile';
import type { SecretFileGuard } from '../../../shared/os/secretFileGuard';
import { buildServicePath, versionDir, type MisaoPaths } from './misaoPaths';
import { bundleFilesFor, sha256File, type MisaoBundle, type MisaoTargetFiles } from './MisaoBundle';
import { MISAO_RELEASE_FILES, MISAO_RELEASE_FILE_NAMES } from '../../servers/transport/agentMisaoSocket';
import { DuplicateLoadError, type ServiceInspection, type ServiceManager } from '../serviceManager';
import { MisaoServiceError } from './MisaoServiceError';
import { renderMisaoUnit } from './misaoUnit';
import { taskStartsMisaoOf, type LocalMisaoWindows } from './misaoLocalWindows';

export interface MisaoServiceDeps {
  /** Null when this hub is not a release install (no prefix): a source checkout never installs a service. */
  paths: MisaoPaths | null;
  /** Why `paths` could not be resolved for a release install (a prefix too long for a unix socket); surfaced instead of failing the hub's startup. */
  pathsError?: string;
  /** Null for a hub that carries no misao (source checkout, or a release without one). */
  bundle: MisaoBundle | null;
  /** Null on a host without systemd / launchd / the Task Scheduler; `controllerError` then says why. */
  controller: ServiceManager | null;
  /** Why `controller` is null (an unknown OS): shown instead of a bare "unsupported platform". */
  controllerError?: string;
  env: NodeJS.ProcessEnv;
  /** Restricts the hub's `.env` (it holds tokens) when MISAO_SOCKET is written into it. */
  secretFileGuard: SecretFileGuard;
  homeDir?: string;
  /**
   * What the running hub knows about the daemon (its `server.info`), and the socket its driver connects to.
   * Absent in the CLI, which has no hub connection: the daemon is then judged by whether its socket accepts a connection.
   */
  hub?: { probeDaemon: () => Promise<MisaoDaemonInfo>; socketPath: string };
  /**
   * Windows only: the hub's own misao is installed, switched and rolled back by the same installer an agent server gets, aimed at
   * this machine (see `misaoLocalWindows.ts`). Present exactly when the host is Windows; `controller` is then the Task Scheduler.
   */
  windows?: LocalMisaoWindows;
  /** How long a started daemon gets to open its socket. */
  readyTimeoutMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 15_000;
const WINDOWS_VERSION_TEXT = /^\d+\.\d+\.\d+$/;

function isSocketListening(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const done = (ok: boolean): void => { socket.destroy(); resolve(ok); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(2_000, () => done(false));
  });
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

  private requireManaged(): { bundle: MisaoBundle; controller: ServiceManager } {
    const { bundle, controller } = this.deps;
    const reason = this.unmanagedReason();
    if (reason === 'invalid_prefix') throw new MisaoServiceError('not_managed', this.deps.pathsError!);
    if (reason === 'source_install') throw new MisaoServiceError('not_managed', 'This hub runs from a source checkout. It connects to MISAO_SOCKET (or the default socket) and does not install a service.');
    if (!bundle) throw new MisaoServiceError('not_managed', 'This hub carries no bundled misao, so it cannot install the service.');
    if (!controller) throw new MisaoServiceError('not_managed', this.deps.controllerError ?? 'This host has neither systemd, launchd nor the Task Scheduler, so the misao service cannot be managed.');
    return { bundle, controller };
  }

  installedVersion(): string | undefined {
    if (!this.deps.paths) return undefined;
    if (this.deps.windows) {
      // No link on Windows: `current` is a file holding the version (what the task's release is).
      try {
        const text = fs.readFileSync(this.paths.current, 'utf-8').trim();
        return WINDOWS_VERSION_TEXT.test(text) ? text : undefined;
      } catch {
        return undefined;
      }
    }
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

  /** systemd / launchd: the unit file exists. Windows: the task is registered (the installer registers it itself, so there is no definition copy to look for). */
  private async isServiceInstalled(): Promise<boolean> {
    const { windows, controller } = this.deps;
    if (windows) return (await windows.tasks.query(windows.taskName)).exists;
    return controller?.isInstalled() ?? false;
  }

  /** The service's state and whether it is installed. Windows: from ONE query of the task (a status poll is two process starts otherwise). */
  private async inspectService(): Promise<{ installed: boolean; inspection?: ServiceInspection }> {
    const { windows, controller } = this.deps;
    if (!windows) {
      const installed = await this.isServiceInstalled();
      return { installed, ...(controller && installed ? { inspection: await controller.inspect() } : {}) };
    }
    const task = await windows.tasks.query(windows.taskName);
    if (!task.exists) return { installed: false };
    return { installed: true, inspection: { state: task.running ? 'active' : task.failed ? 'failed' : 'inactive', domains: [] } };
  }

  async status(): Promise<MisaoServiceStatus> {
    const { bundle, controller, hub } = this.deps;
    const reason = this.unmanagedReason();
    const daemon: MisaoDaemonInfo = hub
      ? await hub.probeDaemon()
      : { reachable: this.deps.paths ? await isSocketListening(this.deps.paths.socket) : false };
    const { installed: serviceInstalled, inspection } = await this.inspectService();
    const unmanagedDetail = this.deps.pathsError ?? (reason === 'unsupported_platform' ? this.deps.controllerError : undefined);
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
      ...(unmanagedDetail ? { unmanagedDetail } : {}),
      ...(controller ? { serviceManager: controller.kind } : {}),
      serviceInstalled,
      ...(inspection ? { serviceState: inspection.state } : {}),
      ...(inspection?.domains.length === 1 ? { serviceDomain: inspection.domains[0] } : {}),
      ...(inspection && inspection.domains.length > 1 ? { serviceDuplicateLoad: true } : {}),
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
   * when it is not running. Safe to repeat. An older version that is running is left entirely alone (neither `current` nor
   * the unit is touched; switching it kills the panes): only `update()` does that. An older version that is NOT running is
   * moved to the bundled one (`current` and the unit), and put back if that fails. `replaceSocketSetting` lets it
   * overwrite a MISAO_SOCKET that points elsewhere.
   */
  install(opts: { replaceSocketSetting?: boolean } = {}): Promise<MisaoServiceStatus> {
    return this.exclusive(() => this.doInstall(opts));
  }

  private async doInstall(opts: { replaceSocketSetting?: boolean }): Promise<MisaoServiceStatus> {
    const { bundle, controller } = this.requireManaged();
    if (this.deps.windows) return this.installOnWindows(this.deps.windows, bundle, opts);
    await controller.loadedDomain();
    if (this.socketSetting() === 'custom' && !opts.replaceSocketSetting) {
      throw new MisaoServiceError('custom_socket', `MISAO_SOCKET in ${this.paths.hubEnvFile} points at another daemon (${readEnvValue(this.paths.hubEnvFile, 'MISAO_SOCKET')}). Installing the managed service would move the hub away from it; run \`azito misao install --replace-socket\` to do that on purpose.`);
    }

    // MISAO_SOCKET unset means the hub uses the default socket. A daemon already answering there (a self-run one from the
    // experimental days) would be left behind by the new setting, so that too needs an explicit go-ahead.
    const defaultSocket = path.join(this.deps.homeDir ?? os.homedir(), '.misao', 'misao.sock');
    if (this.socketSetting() === 'unset' && !opts.replaceSocketSetting && await isSocketListening(defaultSocket)) {
      throw new MisaoServiceError('custom_socket', `A misao daemon is already running on the default socket (${defaultSocket}), which this hub uses while MISAO_SOCKET is unset. Installing the managed service would move the hub away from it; run \`azito misao install --replace-socket\` to do that on purpose.`);
    }

    const files = bundleFilesFor(bundle, process.platform, process.arch);
    this.ensureRootDir();
    this.extractVersion(bundle.version, files);
    const installed = this.installedVersion();
    // An older release that is serving panes is left entirely alone: switching it, or rewriting the unit that starts it
    // (a crash restart would follow the new unit), is an explicit `update`. The new files only wait beside it.
    const olderRunning = installed !== undefined && installed !== bundle.version && (await controller.state()) === 'active';
    if (installed !== undefined && installed !== bundle.version && !olderRunning) {
      await this.moveStoppedInstall(bundle, controller, installed);
    } else {
      if (!olderRunning) await this.registerBundled(bundle, controller, installed);
      await this.pointHubAndStart(controller);
    }
    return this.status();
  }

  /**
   * Windows: the installer an agent gets, on this machine. The same promises as above: a daemon of an older release that is
   * running is left alone, a daemon AZITO did not install is refused. MISAO_SOCKET (the named pipe) is written once the daemon
   * answers, so a failed install leaves the hub's `.env` as it was.
   */
  private async installOnWindows(windows: LocalMisaoWindows, bundle: MisaoBundle, opts: { replaceSocketSetting?: boolean }): Promise<MisaoServiceStatus> {
    if (this.socketSetting() === 'custom' && !opts.replaceSocketSetting) {
      throw new MisaoServiceError('custom_socket', `MISAO_SOCKET in ${this.paths.hubEnvFile} points at another daemon (${readEnvValue(this.paths.hubEnvFile, 'MISAO_SOCKET')}). Installing the managed service would move the hub away from it; run \`azito misao install --replace-socket\` to do that on purpose.`);
    }
    await this.refuseTaskOfAnotherRoot(windows, opts.replaceSocketSetting === true);
    await windows.installer.install(windows.target, bundle, () => undefined);
    upsertEnvValue(this.paths.hubEnvFile, 'MISAO_SOCKET', this.paths.socket, this.deps.secretFileGuard);
    return this.status();
  }

  /**
   * The task name is one per user (an agent on this machine uses it too). A task that starts a misao from another folder is
   * another install's: replacing it would leave that install without its daemon, so it takes `--replace-socket` (the one
   * "move this hub to the managed misao on purpose" switch).
   */
  private async refuseTaskOfAnotherRoot(windows: LocalMisaoWindows, replace: boolean): Promise<void> {
    if (replace || !(await windows.tasks.query(windows.taskName)).exists) return;
    const xml = await windows.tasks.exportXml(windows.taskName);
    if (!taskStartsMisaoOf(xml, this.paths.root)) {
      throw new MisaoServiceError('custom_socket', `The task "${windows.taskName}" is registered for a misao in another folder, not ${this.paths.root}. Installing here would take it over; run \`azito misao install --replace-socket\` to do that on purpose.`);
    }
  }

  /** Writes MISAO_SOCKET into the hub's `.env`, and starts the service when it is not running (never restarts a running one). */
  private async pointHubAndStart(controller: ServiceManager): Promise<void> {
    upsertEnvValue(this.paths.hubEnvFile, 'MISAO_SOCKET', this.paths.socket, this.deps.secretFileGuard);
    if ((await controller.state()) !== 'active') {
      await controller.start();
      await this.waitUntilListening();
    }
  }

  /** Points `current` at the bundled version and writes its unit, with nothing running. A launchd job is booted out first: it keeps the definition of a loaded job. */
  private async registerBundled(bundle: MisaoBundle, controller: ServiceManager, installed: string | undefined): Promise<void> {
    if (installed !== bundle.version) this.switchCurrent(bundle.version);
    await controller.install(this.renderUnit(bundle, controller));
  }

  /**
   * An older release is installed but not running: move to the bundled one, as one transaction. Everything up to the start
   * is covered (the link, the unit, `.env`, the start and the wait for the socket). If any of it fails, the new daemon is
   * stopped and the previous link, unit file and `.env` are put back: the old unit may run `node current/misao.mjs`, which
   * the new layout no longer provides. The old release is NOT started: it was not running.
   */
  private async moveStoppedInstall(bundle: MisaoBundle, controller: ServiceManager, installed: string): Promise<void> {
    const previousDefinition = controller.readDefinition();
    const envFile = this.paths.hubEnvFile;
    const previousEnv = fs.existsSync(envFile) ? fs.readFileSync(envFile) : undefined;
    try {
      await controller.stop();
      await this.registerBundled(bundle, controller, installed);
      await this.pointHubAndStart(controller);
    } catch (err) {
      const failed: string[] = [];
      const attempt = async (what: string, step: () => void | Promise<void>): Promise<void> => {
        try { await step(); } catch (restoreErr) { failed.push(`${what}: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}`); }
      };
      await attempt('stopping the new daemon', () => controller.stop());
      await attempt(`the link ${this.paths.current}`, () => this.switchCurrent(installed));
      if (previousDefinition !== undefined) await attempt('the service definition', () => controller.install(previousDefinition));
      await attempt('MISAO_SOCKET in the hub .env', () => {
        if (previousEnv !== undefined) fs.writeFileSync(envFile, previousEnv);
        else fs.rmSync(envFile, { force: true });
      });
      if (failed.length > 0) {
        throw new MisaoServiceError('update_failed', `Moving misao to ${bundle.version} failed (${err instanceof Error ? err.message : String(err)}) and putting ${installed} back failed too (could not restore: ${failed.join('; ')}). To restore by hand: ln -sfn ${installed} ${this.paths.current}, put the previous service definition back, and check MISAO_SOCKET in ${envFile}.`);
      }
      throw err;
    }
  }

  /** Starts the installed service when it is not running. It never restarts a running daemon. */
  start(): Promise<MisaoServiceStatus> {
    return this.exclusive(() => this.doStart());
  }

  private async doStart(): Promise<MisaoServiceStatus> {
    const { controller } = this.requireManaged();
    await controller.loadedDomain();
    if (!(await this.isServiceInstalled())) throw new MisaoServiceError('not_installed', 'The misao service is not installed. Run `azito misao install` first.');
    // Starting another install's task would wait for a pipe that never opens: only the folder this hub manages is started.
    if (this.deps.windows) await this.refuseTaskOfAnotherRoot(this.deps.windows, false);
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
    // A job loaded twice is refused before anything else (the same-version shortcut below and "already active" would otherwise report success).
    await controller.loadedDomain();
    if (!(await this.isServiceInstalled()) || !this.installedVersion()) {
      throw new MisaoServiceError('not_installed', 'The misao service is not installed. Run `azito misao install` first.');
    }
    // Windows: the installer's own stop / switch / start with its rollback (the same steps as an agent's update).
    if (this.deps.windows) {
      // Moving the task to another folder is `install --replace-socket`, never an update.
      await this.refuseTaskOfAnotherRoot(this.deps.windows, false);
      await this.deps.windows.installer.update(this.deps.windows.target, bundle, () => undefined);
      return this.status();
    }

    // Already on the bundled version: nothing to switch, and stopping would close every pane for no reason.
    if (this.installedVersion() === bundle.version) return this.doStart();

    const previous = this.installedVersion()!;
    // What ran so far, as it was: the previous release may be one the current template cannot start (a Node-era
    // install has no `misao` binary), so a rollback puts this unit back instead of rendering a new one.
    const previousDefinition = controller.readDefinition();
    if (previousDefinition === undefined) {
      throw new MisaoServiceError('not_installed', 'The misao service is not installed. Run `azito misao install` first.');
    }
    this.extractVersion(bundle.version, bundleFilesFor(bundle, process.platform, process.arch));
    await controller.stop();
    try {
      this.switchCurrent(bundle.version);
      await controller.install(this.renderUnit(bundle, controller));
      await controller.start();
      await this.waitUntilListening();
    } catch (err) {
      return this.recoverFromFailedUpdate(err, previous, previousDefinition, bundle.version, controller);
    }
    return this.status();
  }

  /**
   * The daemon was stopped (its panes are gone) and the switch to the bundled version failed part-way. Put the previous
   * version back and start it, then still report the failure: the update did not happen. If the new daemon is running but
   * only slow to open its socket, it is left alone (restoring would kill a daemon that is about to be ready). If the restore
   * fails too, both errors are reported with the manual steps.
   */
  private async recoverFromFailedUpdate(cause: unknown, previous: string, previousDefinition: string, bundledVersion: string, controller: ServiceManager): Promise<never> {
    const causeText = cause instanceof Error ? cause.message : String(cause);
    const manual = `To restore the previous version by hand: ln -sfn ${previous} ${this.paths.current} && azito misao start`;
    if (cause instanceof MisaoServiceError && cause.code === 'daemon_not_ready' && (await controller.state()) === 'active') {
      throw new MisaoServiceError('update_failed', `Updating misao to ${bundledVersion}: ${causeText} The new daemon is running, so it was left as it is. Check the service log; ${manual}`);
    }
    try {
      // A loaded launchd job keeps its definition (kickstart does not read the plist again): boot it out before putting the old one back.
      await controller.stop();
      this.switchCurrent(previous);
      await controller.install(previousDefinition);
      await controller.start();
      await this.waitUntilListening();
    } catch (restoreErr) {
      const restoreText = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
      throw new MisaoServiceError('update_failed', `Updating misao to ${bundledVersion} failed (${causeText}) and restoring ${previous} failed too (${restoreText}). misao is not running and every pane has ended. ${manual}`);
    }
    throw new MisaoServiceError('update_failed', `Updating misao to ${bundledVersion} failed (${causeText}). The previous version ${previous} was restored and started; its panes had already ended.`);
  }

  /** One install / start / update at a time: two of them interleaving could stop a daemon the other just started. */
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new MisaoServiceError('busy', 'Another misao service operation is still running.');
    this.busy = true;
    try {
      return await operation();
    } catch (err) {
      if (err instanceof DuplicateLoadError) throw new MisaoServiceError('duplicate_load', err.message);
      throw err;
    } finally {
      this.busy = false;
    }
  }

  private ensureRootDir(): void {
    fs.mkdirSync(this.paths.root, { recursive: true, mode: 0o700 });
    // mkdir's mode is masked by the umask and ignored for an existing directory; the daemon refuses anything but 700.
    fs.chmodSync(this.paths.root, 0o700);
  }

  /** Every release file is there and matches the manifest (a directory with only some of them is not a usable release). */
  private isExtracted(dir: string, files: MisaoTargetFiles): boolean {
    return MISAO_RELEASE_FILE_NAMES.every((name) => {
      const file = path.join(dir, name);
      return fs.existsSync(file) && sha256File(file) === files.sha256[name];
    });
  }

  /** Unpacks this host's misao binary and its licenses into `<root>/<version>/`, atomically. An older release's directory is not touched. */
  private extractVersion(version: string, files: MisaoTargetFiles): void {
    const dest = versionDir(this.paths, version);
    if (this.isExtracted(dest, files)) return;

    const staging = `${dest}.tmp-${process.pid}`;
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    for (const [name, mode] of Object.entries(MISAO_RELEASE_FILES)) {
      const target = path.join(staging, name);
      fs.copyFileSync(files.files[name as keyof typeof MISAO_RELEASE_FILES], target);
      fs.chmodSync(target, mode);
    }
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

  private renderUnit(bundle: MisaoBundle, controller: ServiceManager): string {
    if (controller.kind === 'taskscheduler' || controller.templateName === undefined) {
      throw new Error('The misao service definition on Windows is not generated from a unit template yet');
    }
    return renderMisaoUnit({
      template: fs.readFileSync(path.join(bundle.templatesDir, controller.templateName), 'utf-8'),
      manager: controller.kind,
      prefix: this.paths.prefix,
      servicePath: buildServicePath(this.deps.env, this.deps.homeDir ?? os.homedir(), fs.existsSync),
    });
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
