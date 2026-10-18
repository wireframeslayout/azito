import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readMisaoBundle } from './MisaoBundle';
import { LaunchdMisaoController, type CommandRunner } from './MisaoServiceController';
import { MisaoServiceService } from './MisaoServiceService';
import { resolveMisaoPaths, type MisaoPaths } from './misaoPaths';
import { writeHubBundle } from './misaoBundleFixture';

const LEGACY_PLIST = '<plist>/old/node /old/misao/current/misao.mjs</plist>';

/**
 * launchd as far as it matters here: `bootstrap` reads the plist and loads the job (starting the daemon), `kickstart`
 * restarts a loaded job WITHOUT reading the plist again, `bootout` unloads it. The loaded definition is what runs.
 */
class LaunchdEmulator {
  loaded: string | null = null;
  running = false;
  /** The next bootstrap loads the job but its daemon never opens the socket. */
  failNextStart = false;
  readonly calls: string[] = [];
  private server: net.Server | undefined;

  constructor(private readonly socketPath: string) {}

  readonly run: CommandRunner = async (_file, args) => {
    const [sub, ...rest] = args;
    this.calls.push(sub);
    if (sub === 'print') {
      if (this.loaded === null) return { code: 113, stdout: '', stderr: '' };
      return { code: 0, stdout: `\tstate = ${this.running ? 'running' : 'waiting'}\n`, stderr: '' };
    }
    if (sub === 'bootstrap') {
      if (this.loaded !== null) return { code: 5, stdout: '', stderr: 'already loaded' };
      this.loaded = fs.readFileSync(rest[1], 'utf-8');
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

describe('MisaoServiceService with launchd, which keeps the definition of a loaded job', () => {
  let prefix: string;
  let paths: MisaoPaths;
  let emulator: LaunchdEmulator;
  let controller: LaunchdMisaoController;
  let plistPath: string;

  const newService = (): MisaoServiceService => new MisaoServiceService({
    paths,
    bundle: readMisaoBundle(path.join(prefix, 'hub', 'current')),
    controller,
    env: { PATH: '/usr/bin' },
    homeDir: prefix,
    readyTimeoutMs: 400,
  });

  /** A 0.2.0 Node-era install: its directory, `current`, its plist, and the job loaded from that plist. */
  async function installNodeEra(running: boolean): Promise<void> {
    fs.mkdirSync(path.join(paths.root, '0.2.0'), { recursive: true });
    fs.writeFileSync(path.join(paths.root, '0.2.0', 'misao.mjs'), '// node build\n');
    fs.symlinkSync('0.2.0', paths.current);
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, LEGACY_PLIST);
    emulator.loaded = LEGACY_PLIST;
    if (running) await emulator.run('launchctl', ['kickstart', 'x']);
  }

  beforeEach(() => {
    prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'azl-'));
    paths = resolveMisaoPaths(prefix);
    fs.mkdirSync(path.join(prefix, 'hub'), { recursive: true });
    writeHubBundle(path.join(prefix, 'hub', 'current'), '0.3.0', '#!/bin/sh\n# misao');
    emulator = new LaunchdEmulator(paths.socket);
    controller = new LaunchdMisaoController(emulator.run, prefix, 501);
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
  });

  it('a failed update puts the previous definition back into the job (the new one is booted out before the old plist is loaded again)', async () => {
    await installNodeEra(true);
    emulator.failNextStart = true;

    await expect(newService().update()).rejects.toMatchObject({ code: 'update_failed', message: expect.stringContaining('was restored and started') });

    expect(emulator.loaded).toBe(LEGACY_PLIST);
    expect(fs.readFileSync(plistPath, 'utf-8')).toBe(LEGACY_PLIST);
    expect(fs.readlinkSync(paths.current)).toBe('0.2.0');
    expect(emulator.running).toBe(true);
  });

  it('a successful update loads the new definition', async () => {
    await installNodeEra(true);

    await newService().update();

    expect(emulator.loaded).toContain(`${prefix}/misao/current/misao`);
    expect(emulator.loaded).not.toContain('misao.mjs');
    expect(fs.readlinkSync(paths.current)).toBe('0.3.0');
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
