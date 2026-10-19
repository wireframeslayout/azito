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
  /** What to tell the user when launchd has the job loaded into both domains (two copies): how to get back to one. */
  duplicateLoadFix: string;
}

export const HUB_SERVICE: ServiceSpec = {
  systemdUnit: 'azito',
  launchdLabel: 'com.azito.hub',
  templates: { systemd: 'azito-release.service', launchd: 'com.azito.hub.plist' },
  duplicateLoadFix: 'Run `azito service stop` (it boots both out), then `azito service start`.',
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

/** The state, and the launchd domains the job is loaded into (empty for systemd and for an unloaded job), from one inspection. */
export interface ServiceInspection {
  state: MisaoServiceState;
  domains: LaunchdDomain[];
}

/** launchd has the job loaded into both `gui/<uid>` and `user/<uid>`: which one an operation means is not guessed. */
export class DuplicateLoadError extends Error {
  constructor(label: string, uid: number, fix: string) {
    super(`${label} is loaded into both gui/${uid} and user/${uid}, so there are two copies and it is not guessed which one is meant. ${fix}`);
    this.name = 'DuplicateLoadError';
  }
}

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
  /**
   * Starts the service when it is not running. launchd: bootstraps an unloaded job (re-reading the plist) into `domain`
   * (default: `gui` when that domain exists, else `user`), only kickstarts a loaded one. A caller that stopped the job
   * itself passes the domain it was in, so putting it back never moves it to the other domain.
   */
  start(domain?: LaunchdDomain): Promise<void>;
  /** Stops the service. launchd: boots the job out of every domain it is loaded into (and so unloads the definition). */
  stop(): Promise<void>;
  /** Restarts a running service, or starts a stopped one. launchd: throws `DuplicateLoadError` when it is loaded twice. */
  restart(): Promise<void>;
  /**
   * Makes the service run its current definition. systemd: `daemon-reload`, then `restart`. launchd: boots the job out
   * and bootstraps it again into the domain it was in (`DuplicateLoadError` when it is loaded twice).
   */
  reload(): Promise<void>;
  /** State and domains from one inspection. Never throws for a double load: the caller reports it. */
  inspect(): Promise<ServiceInspection>;
  state(): Promise<MisaoServiceState>;
  /** launchd: the one domain the job is loaded into, or undefined when it is not loaded (always undefined for systemd). Throws `DuplicateLoadError` when it is loaded twice. */
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

  async reload(): Promise<void> {
    await mustSucceed(this.run, 'systemctl', ['--user', 'daemon-reload'], 'systemctl daemon-reload');
    await this.restart();
  }

  async inspect(): Promise<ServiceInspection> {
    const { stdout } = await this.run('systemctl', ['--user', 'is-active', this.unit]);
    const word = stdout.trim();
    let state: MisaoServiceState = 'unknown';
    if (word === 'active') state = 'active';
    else if (word === 'failed') state = 'failed';
    else if (word === 'inactive' || word === 'activating' || word === 'deactivating') state = 'inactive';
    return { state, domains: [] };
  }

  async state(): Promise<MisaoServiceState> {
    return (await this.inspect()).state;
  }

  async loadedDomain(): Promise<undefined> {
    return undefined;
  }
}

/**
 * `launchctl print gui/<uid>` exits with these when the user has no GUI session (nobody is logged in on the screen,
 * e.g. a Mac reached only over SSH), and so the `gui` domain does not exist:
 * - 125 "Domain does not support specified action": observed on macOS 26.6.2 with `user/<uid>` but no `gui/<uid>` (#366).
 * - 113 "Could not find domain for ...": launchctl's usual exit for a missing domain. NOT observed on a real Mac for this
 *   case; it is accepted defensively, next to the observed 125.
 * Any other failure is not read as "no GUI session": the domain cannot be decided, so it is an error.
 */
const GUI_DOMAIN_ABSENT_EXIT_CODES: ReadonlySet<number> = new Set([125, 113]);

const DOMAINS: readonly LaunchdDomain[] = ['gui', 'user'];

/**
 * launchd. A LaunchAgent is bootstrapped into `gui/<uid>` (a logged-in screen session) when that domain exists, and
 * into `user/<uid>` when it does not. A job that is already loaded into a domain stays there: every later operation
 * (kickstart, bootout, print) uses the domain it is loaded into, and a second copy is never loaded. A job loaded into
 * BOTH domains is an error for every operation that would have to choose (only `stop` and `inspect` work on it).
 */
export class LaunchdServiceManager implements ServiceManager {
  readonly kind = 'launchd' as const;
  readonly templateName: string;
  private readonly label: string;
  private readonly plistPath: string;
  private readonly duplicateLoadFix: string;

  constructor(private readonly run: CommandRunner, spec: ServiceSpec, homeDir: string, private readonly uid: number) {
    this.label = spec.launchdLabel;
    this.templateName = spec.templates.launchd;
    this.duplicateLoadFix = spec.duplicateLoadFix;
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

  private jobTarget(domain: LaunchdDomain): string {
    return `${this.domainTarget(domain)}/${this.label}`;
  }

  /** `launchctl print` of the job in each domain: one call per domain, in `gui` then `user` order. */
  private async printJobs(): Promise<{ domain: LaunchdDomain; result: CommandResult }[]> {
    const jobs: { domain: LaunchdDomain; result: CommandResult }[] = [];
    for (const domain of DOMAINS) {
      jobs.push({ domain, result: await this.run('launchctl', ['print', this.jobTarget(domain)]) });
    }
    return jobs;
  }

  async inspect(): Promise<ServiceInspection> {
    const loaded = (await this.printJobs()).filter((job) => job.result.code === 0);
    const running = loaded.some((job) => {
      const match = /^\s*state = (\w+)/m.exec(job.result.stdout);
      return match?.[1] === 'running';
    });
    const unknown = loaded.length > 0 && loaded.every((job) => !/^\s*state = (\w+)/m.test(job.result.stdout));
    const state: MisaoServiceState = loaded.length === 0 ? 'inactive' : running ? 'active' : unknown ? 'unknown' : 'inactive';
    return { state, domains: loaded.map((job) => job.domain) };
  }

  async state(): Promise<MisaoServiceState> {
    return (await this.inspect()).state;
  }

  async loadedDomain(): Promise<LaunchdDomain | undefined> {
    const { domains } = await this.inspect();
    if (domains.length > 1) throw new DuplicateLoadError(this.label, this.uid, this.duplicateLoadFix);
    return domains[0];
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

  private async bootstrap(domain: LaunchdDomain): Promise<void> {
    const target = this.domainTarget(domain);
    await mustSucceed(this.run, 'launchctl', ['bootstrap', target, this.plistPath], `launchctl bootstrap ${target}`);
  }

  async start(domain?: LaunchdDomain): Promise<void> {
    // `bootstrap` reads the plist again, so an edited plist takes effect; a loaded job is only kicked.
    const loaded = await this.loadedDomain();
    if (loaded) {
      await mustSucceed(this.run, 'launchctl', ['kickstart', this.jobTarget(loaded)], 'launchctl kickstart');
      return;
    }
    await this.bootstrap(domain ?? await this.domainToBootstrap());
  }

  async stop(): Promise<void> {
    // Every domain the job is loaded into, not just the first: a copy macOS loaded into gui/ at a later login would
    // otherwise survive a stop of the one in user/ (or the other way round).
    const { domains } = await this.inspect();
    for (const domain of domains) {
      await mustSucceed(this.run, 'launchctl', ['bootout', this.jobTarget(domain)], 'launchctl bootout');
    }
  }

  /** launchd has no `restart` verb: `kickstart -k` sends SIGTERM to the running job and starts it again. */
  async restart(): Promise<void> {
    const loaded = await this.loadedDomain();
    if (!loaded) return this.start();
    await mustSucceed(this.run, 'launchctl', ['kickstart', '-k', this.jobTarget(loaded)], 'launchctl kickstart');
  }

  async reload(): Promise<void> {
    const loaded = await this.loadedDomain();
    if (!loaded) return this.start();
    await mustSucceed(this.run, 'launchctl', ['bootout', this.jobTarget(loaded)], 'launchctl bootout');
    await this.bootstrap(loaded);
  }
}

/** The service manager of a known kind (the update script is told which one the hub runs under). */
export function serviceManagerOfKind(kind: ServiceManagerKind, spec: ServiceSpec, run: CommandRunner, host: Pick<HostEnv, 'homeDir' | 'uid'>): ServiceManager {
  return kind === 'systemd' ? new SystemdServiceManager(run, spec, host.homeDir) : new LaunchdServiceManager(run, spec, host.homeDir, host.uid);
}

export type ServiceManagerResult = { manager: ServiceManager } | { error: HostProfileError };

/**
 * The service manager of this host. Windows (a known OS; the Task Scheduler implementation is #380) is `unsupported_os`
 * and any other OS is `unsupported_host`: both with the reason, never a fallback to another manager.
 */
export function createServiceManager(host: Pick<HostEnv, 'platform' | 'homeDir' | 'uid'>, spec: ServiceSpec, run: CommandRunner): ServiceManagerResult {
  if (host.platform === 'linux') return { manager: serviceManagerOfKind('systemd', spec, run, host) };
  if (host.platform === 'darwin') return { manager: serviceManagerOfKind('launchd', spec, run, host) };
  if (host.platform === 'win32') {
    return { error: new HostProfileError('unsupported_os', 'Managing the service on Windows (Task Scheduler) is not supported yet: only systemd (Linux) and launchd (macOS) are.') };
  }
  return { error: new HostProfileError('unsupported_host', `This host (${host.platform}) has neither systemd nor launchd, so its service cannot be managed.`) };
}
