import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readMisaoBundle } from './MisaoBundle';
import { LaunchdServiceManager, limitToBackgroundSession, type CommandRunner, type LaunchdTiming } from '../serviceManager';
import { MisaoServiceService } from './MisaoServiceService';
import { MISAO_SERVICE, resolveMisaoPaths, type MisaoPaths } from './misaoPaths';
import { writeHubBundle } from './misaoBundleFixture';
import { createSecretFileGuard } from '../../../shared/os/secretFileGuard';

const LEGACY_PLIST = '<plist version="1.0">\n<dict>\n  <key>Label</key>\n  <string>com.azito.misao</string>\n  <key>ProgramArguments</key>\n  <string>/old/node /old/misao/current/misao.mjs</string>\n</dict>\n</plist>\n';
const TIMING: LaunchdTiming = { settleTimeoutMs: 200, pollIntervalMs: 1, bootstrapRetries: 2, retryDelayMs: 1 };

/**
 * launchd as far as it matters here: `bootstrap` reads the plist and loads the job (starting the daemon), `kickstart`
 * restarts a loaded job WITHOUT reading the plist again, `bootout` unloads it. The loaded definition is what runs.
 * As found on a real Mac (#366): `user/<uid>` only takes a plist limited to the Background session type, `gui/<uid>`
 * only one that is not, and for a moment after a bootout `print` still reports the job and a bootstrap answers 5.
 */
class LaunchdEmulator {
  loaded: string | null = null;
  /** The domain the job was loaded into. */
  loadedDomain: 'gui' | 'user' | null = null;
  running = false;
  /** The next bootstrap loads the job but its daemon never opens the socket. */
  failNextStart = false;
  /** How many `print` / `bootstrap` answers still see a job that was just booted out. */
  lingerAfterBootout = 0;
  readonly calls: string[] = [];
  private lingering = 0;
  private server: net.Server | undefined;

  constructor(private readonly socketPath: string) {}

  readonly run: CommandRunner = async (_file, args) => {
    const [sub, ...rest] = args;
    this.calls.push(sub);
    if (sub === 'print') {
      const [domain, label] = rest[0].split(/\/(?=com\.)/);
      if (label === undefined) return { code: 0, stdout: '', stderr: '' };
      if (this.loaded === null || this.loadedDomain !== domain.split('/')[0]) {
        if (this.lingering > 0) {
          this.lingering--;
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 113, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: `\tstate = ${this.running ? 'running' : 'waiting'}\n`, stderr: '' };
    }
    if (sub === 'bootstrap') {
      const domain = rest[0].split('/')[0] as 'gui' | 'user';
      const plist = fs.readFileSync(rest[1], 'utf-8');
      const limited = plist.includes('LimitLoadToSessionType');
      if ((domain === 'user') !== limited) return { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
      if (this.lingering > 0) {
        this.lingering--;
        return { code: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };
      }
      if (this.loaded !== null) return { code: 5, stdout: '', stderr: 'already loaded' };
      this.loaded = plist;
      this.loadedDomain = domain;
      await this.startDaemon();
      return { code: 0, stdout: '', stderr: '' };
    }
    if (sub === 'kickstart') {
      if (this.loaded === null) return { code: 113, stdout: '', stderr: '' };
      await this.startDaemon();
      return { code: 0, stdout: '', stderr: '' };
    }
    if (sub === 'bootout') {
      this.loaded = null;
      this.loadedDomain = null;
      this.lingering = this.lingerAfterBootout;
      await this.stopDaemon();
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected ${sub}` };
  };

  private async startDaemon(): Promise<void> {
    if (this.failNextStart) {
      this.failNextStart = false;
      return;
    }
    await this.stopDaemon();
    fs.rmSync(this.socketPath, { force: true });
    this.server = net.createServer();
    await new Promise<void>((resolve) => this.server!.listen(this.socketPath, resolve));
    this.running = true;
  }

  async stopDaemon(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.running = false;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe.each([
  ['an older install in gui/501 (v0.11.x and earlier)', 'gui'],
  ['a job already in user/501', 'user'],
] as const)('MisaoServiceService with launchd, which keeps the definition of a loaded job: %s', (_name, jobDomain) => {
  let prefix: string;
  let paths: MisaoPaths;
  let emulator: LaunchdEmulator;
  let controller: LaunchdServiceManager;
  let plistPath: string;

  const newService = (): MisaoServiceService => new MisaoServiceService({
    paths,
    bundle: readMisaoBundle(path.join(prefix, 'hub', 'current')),
    controller,
    env: { PATH: '/usr/bin' },
    secretFileGuard: createSecretFileGuard(process.platform, process.env),
    homeDir: prefix,
    readyTimeoutMs: 400,
  });

  /** A 0.2.0 Node-era install: its directory, `current`, its plist, and the job loaded from that plist. */
  async function installNodeEra(running: boolean): Promise<void> {
    fs.mkdirSync(path.join(paths.root, '0.2.0'), { recursive: true });
    fs.writeFileSync(path.join(paths.root, '0.2.0', 'misao.mjs'), '// node build\n');
    fs.symlinkSync('0.2.0', paths.current);
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    // A job in user/ was loaded from a limited plist (launchd takes nothing else there); an older install's gui job from the plain one.
    const loadedPlist = jobDomain === 'user' ? limitToBackgroundSession(LEGACY_PLIST) : LEGACY_PLIST;
    fs.writeFileSync(plistPath, loadedPlist);
    emulator.loaded = loadedPlist;
    emulator.loadedDomain = jobDomain;
    emulator.lingerAfterBootout = 3;
    if (running) await emulator.run('launchctl', ['kickstart', 'x']);
  }

  beforeEach(() => {
    prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'azl-'));
    paths = resolveMisaoPaths(prefix);
    fs.mkdirSync(path.join(prefix, 'hub'), { recursive: true });
    writeHubBundle(path.join(prefix, 'hub', 'current'), '0.3.0', '#!/bin/sh\n# misao');
    emulator = new LaunchdEmulator(paths.socket);
    controller = new LaunchdServiceManager(emulator.run, MISAO_SERVICE, prefix, 501, TIMING);
    plistPath = path.join(prefix, 'Library', 'LaunchAgents', 'com.azito.misao.plist');
    fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  });

  afterEach(async () => {
    await emulator.stopDaemon();
    fs.rmSync(prefix, { recursive: true, force: true });
  });

  it('install moves a stopped (loaded but not running) older job to the new definition: it is booted out first, so bootstrap reads the new plist', async () => {
    await installNodeEra(false);

    await newService().install();

    expect(emulator.loaded).toContain(`${prefix}/misao/current/misao`);
    expect(emulator.loaded).not.toContain('misao.mjs');
    expect(emulator.running).toBe(true);
    expect(emulator.loadedDomain).toBe('user');
  });

  it('a fresh install loads the job into user/<uid> and reports it in the status', async () => {
    const status = await newService().install();

    expect(emulator.loadedDomain).toBe('user');
    expect(status).toMatchObject({ serviceManager: 'launchd', serviceState: 'active', serviceDomain: 'user' });
  });

  it('a failed update puts the previous definition back into the job, in user/<uid> (the new one is booted out before the old plist is loaded again)', async () => {
    await installNodeEra(true);
    emulator.failNextStart = true;

    await expect(newService().update()).rejects.toMatchObject({ code: 'update_failed', message: expect.stringContaining('was restored and started') });

    // The old definition runs again; an older install's plist only gets the session limit added, which user/<uid> needs.
    expect(emulator.loaded).toBe(limitToBackgroundSession(LEGACY_PLIST));
    expect(fs.readFileSync(plistPath, 'utf-8')).toBe(limitToBackgroundSession(LEGACY_PLIST));
    expect(fs.readlinkSync(paths.current)).toBe('0.2.0');
    expect(emulator.running).toBe(true);
    expect(emulator.loadedDomain).toBe('user');
  });

  it('a successful update loads the new definition', async () => {
    await installNodeEra(true);

    await newService().update();

    expect(emulator.loaded).toContain(`${prefix}/misao/current/misao`);
    expect(emulator.loaded).not.toContain('misao.mjs');
    expect(fs.readlinkSync(paths.current)).toBe('0.3.0');
    expect(emulator.loadedDomain).toBe('user');
  });

  it('an install does not boot out a running daemon of the same version (it only rewrites the file)', async () => {
    const service = newService();
    await service.install();
    emulator.calls.length = 0;

    await service.install();

    expect(emulator.calls).not.toContain('bootout');
    expect(emulator.running).toBe(true);
  });
});
