import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import type { MisaoServiceState } from '@azito/shared';
import type { HostEnv } from '../../shared/os/hostEnv';
import { HostProfileError } from '../../shared/os/hostProfile';

/**
 * How a service on THIS host (the one the hub runs on) is managed. 'source' has no service manager, so it is not
 * representable here. Services on agent servers are not managed through this interface (they go through the agent).
 */
export type ServiceManagerKind = 'systemd' | 'launchd';

export function isServiceManagerKind(value: string): value is ServiceManagerKind {
  return value === 'systemd' || value === 'launchd';
}

/** The launchd domain a job lives in: the per-user GUI session (`gui/<uid>`) or the per-user background domain (`user/<uid>`). */
export type LaunchdDomain = 'gui' | 'user';

/** The service definitions of one service: the hub itself, or misao. */
export interface ServiceSpec {
  systemdUnit: string;
  launchdLabel: string;
  /** Unit / plist template file names inside the bundle's `deploy/`. */
  templates: { systemd: string; launchd: string };
}

export const HUB_SERVICE: ServiceSpec = {
  systemdUnit: 'azito',
  launchdLabel: 'com.azito.hub',
  templates: { systemd: 'azito-release.service', launchd: 'com.azito.hub.plist' },
};

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command and reports its exit code; only a failure to spawn rejects. */
export type CommandRunner = (file: string, args: string[]) => Promise<CommandResult>;

export const runCommand: CommandRunner = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 60_000 }, (err, stdout, stderr) => {
    if (!err) return resolve({ code: 0, stdout, stderr });
    const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
    if (typeof code === 'number') return resolve({ code, stdout, stderr });
    reject(err);
  });
});

/** A service of the hub's own host: its definition file, and start / stop / restart / state. `install` does not start. */
export interface ServiceManager {
  readonly kind: ServiceManagerKind;
  /** Unit / plist template file name inside the bundle's `deploy/`. */
  readonly templateName: string;
  isInstalled(): boolean;
  /** The unit/plist as installed now, or undefined when there is none (a failed update puts it back as it was). */
  readDefinition(): string | undefined;
  /** Writes the unit/plist and registers it (enable at login) without starting it. Also how a previous definition is put back. */
  install(content: string): Promise<void>;
  /** Starts the service when it is not running. launchd: bootstraps an unloaded job (re-reading the plist), only kickstarts a loaded one. */
  start(): Promise<void>;
  /** Stops the service. launchd: boots the job out of every domain it is loaded into (and so unloads the definition). */
  stop(): Promise<void>;
  /** Restarts a running service, or starts a stopped one. */
  restart(): Promise<void>;
  state(): Promise<MisaoServiceState>;
  /** launchd: the domain the job is loaded into now. undefined when it is not loaded, and always for systemd. */
  loadedDomain(): Promise<LaunchdDomain | undefined>;
}

function readIfExists(file: string): string | undefined {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : undefined;
}

async function mustSucceed(run: CommandRunner, file: string, args: string[], what: string): Promise<CommandResult> {
  const result = await run(file, args);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`${what} failed (exit ${result.code})${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

export class SystemdServiceManager implements ServiceManager {
  readonly kind = 'systemd' as const;
  readonly templateName: string;
  private readonly unit: string;
  private readonly unitPath: string;

  constructor(private readonly run: CommandRunner, spec: ServiceSpec, homeDir: string) {
    this.unit = spec.systemdUnit;
    this.templateName = spec.templates.systemd;
    this.unitPath = path.join(homeDir, '.config', 'systemd', 'user', `${this.unit}.service`);
  }

  isInstalled(): boolean {
    return fs.existsSync(this.unitPath);
  }

  readDefinition(): string | undefined {
    return readIfExists(this.unitPath);
  }

  async install(content: string): Promise<void> {
    fs.mkdirSync(path.dirname(this.unitPath), { recursive: true });
    fs.writeFileSync(this.unitPath, content);
    await mustSucceed(this.run, 'systemctl', ['--user', 'daemon-reload'], 'systemctl daemon-reload');
    await mustSucceed(this.run, 'systemctl', ['--user', 'enable', this.unit], 'systemctl enable');
    // Best effort, like the hub's own installer: lingering keeps the user manager (and so the daemon) alive after logout.
    await this.run('loginctl', ['enable-linger', os.userInfo().username]).catch(() => undefined);
  }

  async start(): Promise<void> {
    await mustSucceed(this.run, 'systemctl', ['--user', 'start', this.unit], 'systemctl start');
  }

  async stop(): Promise<void> {
    await mustSucceed(this.run, 'systemctl', ['--user', 'stop', this.unit], 'systemctl stop');
  }

  async restart(): Promise<void> {
    await mustSucceed(this.run, 'systemctl', ['--user', 'restart', this.unit], 'systemctl restart');
  }

  async state(): Promise<MisaoServiceState> {
    const { stdout } = await this.run('systemctl', ['--user', 'is-active', this.unit]);
    const word = stdout.trim();
    if (word === 'active') return 'active';
    if (word === 'failed') return 'failed';
    if (word === 'inactive' || word === 'activating' || word === 'deactivating') return 'inactive';
    return 'unknown';
  }

  async loadedDomain(): Promise<undefined> {
    return undefined;
  }
}

/**
 * `launchctl print gui/<uid>` exits with these when the user has no GUI session (nobody is logged in on the screen,
 * e.g. a Mac reached only over SSH), and so the `gui` domain does not exist:
 * - 125 "Domain does not support specified action": what macOS 26 printed on a Mac with `user/<uid>` but no `gui/<uid>` (#366).
 * - 113 "Could not find domain for ...": launchctl's usual exit for a domain that does not exist.
 * Any other failure is not read as "no GUI session": the domain cannot be decided, so it is an error.
 */
const GUI_DOMAIN_ABSENT_EXIT_CODES: ReadonlySet<number> = new Set([125, 113]);

/**
 * launchd. A LaunchAgent is bootstrapped into `gui/<uid>` (a logged-in screen session) when that domain exists, and
 * into `user/<uid>` when it does not. A job that is already loaded into either domain stays where it is: every later
 * operation (kickstart, bootout, print) uses the domain it is loaded into, and a second copy is never loaded.
 */
export class LaunchdServiceManager implements ServiceManager {
  readonly kind = 'launchd' as const;
  readonly templateName: string;
  private readonly label: string;
  private readonly plistPath: string;

  constructor(private readonly run: CommandRunner, spec: ServiceSpec, homeDir: string, private readonly uid: number) {
    this.label = spec.launchdLabel;
    this.templateName = spec.templates.launchd;
    this.plistPath = path.join(homeDir, 'Library', 'LaunchAgents', `${this.label}.plist`);
  }

  isInstalled(): boolean {
    return fs.existsSync(this.plistPath);
  }

  readDefinition(): string | undefined {
    return readIfExists(this.plistPath);
  }

  async install(content: string): Promise<void> {
    fs.mkdirSync(path.dirname(this.plistPath), { recursive: true });
    fs.writeFileSync(this.plistPath, content);
  }

  private domainTarget(domain: LaunchdDomain): string {
    return `${domain}/${this.uid}`;
  }

  async loadedDomain(): Promise<LaunchdDomain | undefined> {
    for (const domain of ['gui', 'user'] as const) {
      if ((await this.run('launchctl', ['print', `${this.domainTarget(domain)}/${this.label}`])).code === 0) return domain;
    }
    return undefined;
  }

  /** Where an unloaded job goes: the GUI domain when there is one, else the user domain. */
  private async domainToBootstrap(): Promise<LaunchdDomain> {
    const gui = this.domainTarget('gui');
    const result = await this.run('launchctl', ['print', gui]);
    if (result.code === 0) return 'gui';
    if (GUI_DOMAIN_ABSENT_EXIT_CODES.has(result.code)) return 'user';
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`launchctl print ${gui} failed (exit ${result.code}), so it cannot be told whether ${gui} exists${detail ? `: ${detail}` : ''}`);
  }

  async start(): Promise<void> {
    // `bootstrap` reads the plist again, so an edited plist takes effect; a loaded job is only kicked.
    const loaded = await this.loadedDomain();
    if (loaded) {
      await mustSucceed(this.run, 'launchctl', ['kickstart', `${this.domainTarget(loaded)}/${this.label}`], 'launchctl kickstart');
      return;
    }
    const domain = this.domainTarget(await this.domainToBootstrap());
    await mustSucceed(this.run, 'launchctl', ['bootstrap', domain, this.plistPath], `launchctl bootstrap ${domain}`);
  }

  async stop(): Promise<void> {
    // Every domain the job is loaded into, not just the first: a copy macOS loaded into gui/ at a later login would
    // otherwise survive a stop of the one in user/ (or the other way round).
    for (const domain of ['gui', 'user'] as const) {
      const target = `${this.domainTarget(domain)}/${this.label}`;
      if ((await this.run('launchctl', ['print', target])).code !== 0) continue;
      await mustSucceed(this.run, 'launchctl', ['bootout', target], 'launchctl bootout');
    }
  }

  /** launchd has no `restart` verb: `kickstart -k` sends SIGTERM to the running job and starts it again. */
  async restart(): Promise<void> {
    const loaded = await this.loadedDomain();
    if (!loaded) return this.start();
    await mustSucceed(this.run, 'launchctl', ['kickstart', '-k', `${this.domainTarget(loaded)}/${this.label}`], 'launchctl kickstart');
  }

  async state(): Promise<MisaoServiceState> {
    const loaded = await this.loadedDomain();
    if (!loaded) return 'inactive';
    const result = await this.run('launchctl', ['print', `${this.domainTarget(loaded)}/${this.label}`]);
    if (result.code !== 0) return 'inactive';
    const match = /^\s*state = (\w+)/m.exec(result.stdout);
    if (!match) return 'unknown';
    return match[1] === 'running' ? 'active' : 'inactive';
  }
}

/** The service manager of a known kind (the update script is told which one the hub runs under). */
export function serviceManagerOfKind(kind: ServiceManagerKind, spec: ServiceSpec, run: CommandRunner, homeDir: string, uid: () => number = () => os.userInfo().uid): ServiceManager {
  return kind === 'systemd' ? new SystemdServiceManager(run, spec, homeDir) : new LaunchdServiceManager(run, spec, homeDir, uid());
}

export type ServiceManagerResult = { manager: ServiceManager } | { error: HostProfileError };

/**
 * The service manager of this host. Windows (a known OS; the Task Scheduler implementation is #380) is `unsupported_os`
 * and any other OS is `unsupported_host`: both with the reason, never a fallback to another manager.
 */
export function createServiceManager(host: Pick<HostEnv, 'platform' | 'homeDir'>, spec: ServiceSpec, run: CommandRunner): ServiceManagerResult {
  if (host.platform === 'linux') return { manager: serviceManagerOfKind('systemd', spec, run, host.homeDir) };
  if (host.platform === 'darwin') return { manager: serviceManagerOfKind('launchd', spec, run, host.homeDir) };
  if (host.platform === 'win32') {
    return { error: new HostProfileError('unsupported_os', 'Managing the service on Windows (Task Scheduler) is not supported yet: only systemd (Linux) and launchd (macOS) are.') };
  }
  return { error: new HostProfileError('unsupported_host', `This host (${host.platform}) has neither systemd nor launchd, so its service cannot be managed.`) };
}
