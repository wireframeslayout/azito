import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import type { MisaoServiceState } from '@azito/shared';
import { MISAO_LAUNCHD_LABEL, MISAO_SYSTEMD_UNIT } from './misaoPaths';

export type MisaoServiceManager = 'systemd' | 'launchd';

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

/** The service manager's side of the misao service: the unit file, and start / stop / state. Install does not start. */
export interface MisaoServiceController {
  readonly manager: MisaoServiceManager;
  /** Unit template file name inside the bundle's `deploy/`. */
  readonly templateName: string;
  isInstalled(): boolean;
  /** Writes the unit/plist and registers it (enable at login) without starting it. */
  install(content: string): Promise<void>;
  start(): Promise<void>;
  /** Stops the daemon. It closes every pane before exiting. */
  stop(): Promise<void>;
  state(): Promise<MisaoServiceState>;
}

async function mustSucceed(run: CommandRunner, file: string, args: string[], what: string): Promise<CommandResult> {
  const result = await run(file, args);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`${what} failed (exit ${result.code})${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

export class SystemdMisaoController implements MisaoServiceController {
  readonly manager = 'systemd' as const;
  readonly templateName = 'azito-misao.service';
  private readonly unitPath: string;

  constructor(private readonly run: CommandRunner, homeDir: string = os.homedir()) {
    this.unitPath = path.join(homeDir, '.config', 'systemd', 'user', `${MISAO_SYSTEMD_UNIT}.service`);
  }

  isInstalled(): boolean {
    return fs.existsSync(this.unitPath);
  }

  async install(content: string): Promise<void> {
    fs.mkdirSync(path.dirname(this.unitPath), { recursive: true });
    fs.writeFileSync(this.unitPath, content);
    await mustSucceed(this.run, 'systemctl', ['--user', 'daemon-reload'], 'systemctl daemon-reload');
    await mustSucceed(this.run, 'systemctl', ['--user', 'enable', MISAO_SYSTEMD_UNIT], 'systemctl enable');
    // Best effort, like the hub's own installer: lingering keeps the user manager (and so the daemon) alive after logout.
    await this.run('loginctl', ['enable-linger', os.userInfo().username]).catch(() => undefined);
  }

  async start(): Promise<void> {
    await mustSucceed(this.run, 'systemctl', ['--user', 'start', MISAO_SYSTEMD_UNIT], 'systemctl start');
  }

  async stop(): Promise<void> {
    await mustSucceed(this.run, 'systemctl', ['--user', 'stop', MISAO_SYSTEMD_UNIT], 'systemctl stop');
  }

  async state(): Promise<MisaoServiceState> {
    const { stdout } = await this.run('systemctl', ['--user', 'is-active', MISAO_SYSTEMD_UNIT]);
    const word = stdout.trim();
    if (word === 'active') return 'active';
    if (word === 'failed') return 'failed';
    if (word === 'inactive' || word === 'activating' || word === 'deactivating') return 'inactive';
    return 'unknown';
  }
}

export class LaunchdMisaoController implements MisaoServiceController {
  readonly manager = 'launchd' as const;
  readonly templateName = 'com.azito.misao.plist';
  private readonly plistPath: string;
  private readonly domainTarget: string;

  constructor(private readonly run: CommandRunner, homeDir: string = os.homedir(), uid: number = os.userInfo().uid) {
    this.plistPath = path.join(homeDir, 'Library', 'LaunchAgents', `${MISAO_LAUNCHD_LABEL}.plist`);
    this.domainTarget = `gui/${uid}`;
  }

  isInstalled(): boolean {
    return fs.existsSync(this.plistPath);
  }

  async install(content: string): Promise<void> {
    fs.mkdirSync(path.dirname(this.plistPath), { recursive: true });
    fs.writeFileSync(this.plistPath, content);
  }

  private async isLoaded(): Promise<boolean> {
    return (await this.run('launchctl', ['print', `${this.domainTarget}/${MISAO_LAUNCHD_LABEL}`])).code === 0;
  }

  async start(): Promise<void> {
    // `bootstrap` reads the plist again, so an edited plist takes effect; a loaded job is only kicked.
    if (await this.isLoaded()) {
      await mustSucceed(this.run, 'launchctl', ['kickstart', `${this.domainTarget}/${MISAO_LAUNCHD_LABEL}`], 'launchctl kickstart');
      return;
    }
    await mustSucceed(this.run, 'launchctl', ['bootstrap', this.domainTarget, this.plistPath], 'launchctl bootstrap');
  }

  async stop(): Promise<void> {
    if (!(await this.isLoaded())) return;
    await mustSucceed(this.run, 'launchctl', ['bootout', `${this.domainTarget}/${MISAO_LAUNCHD_LABEL}`], 'launchctl bootout');
  }

  async state(): Promise<MisaoServiceState> {
    const result = await this.run('launchctl', ['print', `${this.domainTarget}/${MISAO_LAUNCHD_LABEL}`]);
    if (result.code !== 0) return 'inactive';
    const match = /^\s*state = (\w+)/m.exec(result.stdout);
    if (!match) return 'unknown';
    return match[1] === 'running' ? 'active' : 'inactive';
  }
}

/** The controller for this host, or null where the platform has no supported service manager. */
export function createMisaoServiceController(platform: NodeJS.Platform, run: CommandRunner): MisaoServiceController | null {
  if (platform === 'linux') return new SystemdMisaoController(run);
  if (platform === 'darwin') return new LaunchdMisaoController(run);
  return null;
}
