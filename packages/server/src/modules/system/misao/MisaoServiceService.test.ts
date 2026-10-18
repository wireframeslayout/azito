import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MisaoServiceState } from '@azito/shared';
import { misaoTargetFor, readMisaoBundle, type MisaoBundle } from './MisaoBundle';
import { fakeBinaryFor, writeHubBundle as writeBundle } from './misaoBundleFixture';
import { MisaoServiceService } from './MisaoServiceService';
import { MisaoServiceError } from './MisaoServiceError';
import type { MisaoServiceController } from './MisaoServiceController';
import { resolveMisaoPaths, type MisaoPaths } from './misaoPaths';
import { readEnvValue } from '../../../shared/envFile';
import { createSecretFileGuard } from '../../../shared/os/secretFileGuard';

const writeHubBundle = (root: string, version: string = BUNDLED_VERSION): void => writeBundle(root, version, `#!/bin/sh\n# misao ${version}`);

const BUNDLED_VERSION = '0.3.0';
/** This host's target: the hub tests run on whatever the developer / CI machine is. */
const HOST_TARGET = misaoTargetFor(process.platform, process.arch);
const LEGACY_UNIT = '[Service]\nExecStart=/old/node /old/misao/current/misao.mjs serve\n';

/** A service manager that records what it was asked, and opens the daemon's socket on start like the real daemon. */
class FakeController implements MisaoServiceController {
  readonly manager = 'systemd' as const;
  readonly templateName = 'azito-misao.service';
  readonly calls: string[] = [];
  installed = false;
  current: MisaoServiceState = 'inactive';
  unit = '';
  private server: net.Server | undefined;

  constructor(private readonly socketPath: string, private readonly currentLink: string) {}

  isInstalled(): boolean { return this.installed; }
  readDefinition(): string | undefined { return this.installed ? this.unit : undefined; }
  async install(content: string): Promise<void> { this.calls.push('install'); this.installed = true; this.unit = content; }
  async start(): Promise<void> {
    this.calls.push(`start:${fs.existsSync(this.currentLink) ? path.basename(fs.readlinkSync(this.currentLink)) : '-'}`);
    this.current = 'active';
    await this.listen();
  }
  async stop(): Promise<void> {
    this.calls.push(`stop:${fs.existsSync(this.currentLink) ? path.basename(fs.readlinkSync(this.currentLink)) : '-'}`);
    this.current = 'inactive';
    await this.close();
  }
  async state(): Promise<MisaoServiceState> { return this.current; }

  private listen(): Promise<void> {
    fs.rmSync(this.socketPath, { force: true });
    this.server = net.createServer();
    return new Promise((resolve) => this.server!.listen(this.socketPath, resolve));
  }
  close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }
}

describe('MisaoServiceService', () => {
  let prefix: string;
  let paths: MisaoPaths;
  let bundle: MisaoBundle;
  let controller: FakeController;

  const newService = (overrides: Partial<ConstructorParameters<typeof MisaoServiceService>[0]> = {}): MisaoServiceService => new MisaoServiceService({
    paths, bundle, controller, env: { PATH: '/usr/bin:/custom/bin' }, secretFileGuard: createSecretFileGuard(process.platform), homeDir: prefix, readyTimeoutMs: 2_000, ...overrides,
  });

  beforeEach(() => {
    // unix socket paths are limited to 107 bytes: keep the temp prefix short
    prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'azm-'));
    paths = resolveMisaoPaths(prefix);
    fs.mkdirSync(path.join(prefix, 'hub'), { recursive: true });
    writeHubBundle(path.join(prefix, 'hub', 'current'));
    bundle = readMisaoBundle(path.join(prefix, 'hub', 'current'))!;
    controller = new FakeController(paths.socket, paths.current);
  });

  afterEach(async () => {
    await controller.close();
    fs.rmSync(prefix, { recursive: true, force: true });
  });

  describe('install', () => {
    it('unpacks the binary for this host and its licenses, points current at it, and starts the service', async () => {
      const status = await newService().install();

      const versionDir = path.join(paths.root, BUNDLED_VERSION);
      expect(fs.readFileSync(path.join(versionDir, 'misao'), 'utf-8')).toBe(fakeBinaryFor(HOST_TARGET, `#!/bin/sh\n# misao ${BUNDLED_VERSION}`));
      expect(fs.statSync(path.join(versionDir, 'misao')).mode & 0o777).toBe(0o755);
      for (const license of ['LICENSE', 'NOTICE', 'THIRD-PARTY-LICENSES.txt']) {
        expect(fs.statSync(path.join(versionDir, license)).mode & 0o777).toBe(0o644);
      }
      expect(fs.existsSync(path.join(versionDir, 'node_modules'))).toBe(false);
      expect(fs.existsSync(path.join(versionDir, 'misao.mjs'))).toBe(false);
      expect(fs.readlinkSync(paths.current)).toBe(BUNDLED_VERSION);
      expect(controller.calls).toEqual(['install', `start:${BUNDLED_VERSION}`]);
      expect(status).toMatchObject({ managed: true, serviceInstalled: true, serviceState: 'active', installedVersion: BUNDLED_VERSION, socketSetting: 'managed', updateAvailable: false });
    });

    it('keeps the socket directory at mode 700 whatever the umask', async () => {
      await newService().install();
      expect(fs.statSync(paths.root).mode & 0o777).toBe(0o700);
    });

    it('renders the unit with the prefix (no node) and a PATH that starts with the usual tool locations, leaving no placeholder', async () => {
      fs.mkdirSync(path.join(prefix, '.local', 'bin'), { recursive: true });
      await newService().install();

      expect(controller.unit).not.toContain('__');
      expect(controller.unit).toContain(`ExecStart=${prefix}/misao/current/misao serve --socket ${paths.socket} --data ${paths.root}`);
      expect(controller.unit).toContain(`Environment=PATH=${prefix}/.local/bin:`);
      expect(controller.unit).toContain('/custom/bin');
      expect(controller.unit).toContain('KillMode=process');
    });

    it('writes MISAO_SOCKET to the hub .env, keeping its other lines', async () => {
      fs.writeFileSync(paths.hubEnvFile, 'AZITO_UI_TOKEN=abc\nPORT=3001\n');
      await newService().install();
      expect(readEnvValue(paths.hubEnvFile, 'MISAO_SOCKET')).toBe(paths.socket);
      expect(readEnvValue(paths.hubEnvFile, 'AZITO_UI_TOKEN')).toBe('abc');
    });

    it('leaves a running daemon alone when run again', async () => {
      const service = newService();
      await service.install();
      controller.calls.length = 0;

      await service.install();
      expect(controller.calls).toEqual(['install']);
    });

    it('does not switch an installed older version: only an explicit update does (the switch closes every pane)', async () => {
      fs.mkdirSync(path.join(paths.root, '0.1.0'), { recursive: true });
      fs.symlinkSync('0.1.0', paths.current);
      controller.current = 'active';
      controller.installed = true;
      controller.unit = LEGACY_UNIT;

      const status = await newService().install();

      expect(fs.readlinkSync(paths.current)).toBe('0.1.0');
      expect(controller.calls).not.toContain('stop:0.1.0');
      expect(status.updateAvailable).toBe(true);
      // Neither the link nor the unit that starts it (a crash restart would follow a new unit) is touched.
      expect(controller.calls).toEqual([]);
      expect(controller.unit).toBe(LEGACY_UNIT);
    });

    it('moves a stopped older install to the bundled version: nothing is running, and the new unit needs the new layout', async () => {
      fs.mkdirSync(path.join(paths.root, '0.2.0'), { recursive: true });
      fs.writeFileSync(path.join(paths.root, '0.2.0', 'misao.mjs'), '// node build\n');
      fs.symlinkSync('0.2.0', paths.current);
      controller.installed = true;
      controller.unit = LEGACY_UNIT;

      await newService().install();

      expect(fs.readlinkSync(paths.current)).toBe(BUNDLED_VERSION);
      expect(controller.unit).toContain(`${prefix}/misao/current/misao serve`);
      expect(fs.existsSync(path.join(paths.root, '0.2.0', 'misao.mjs'))).toBe(true);
      // The job is booted out before its definition changes (launchd keeps the definition of a loaded job).
      expect(controller.calls.slice(0, 2)).toEqual(['stop:0.2.0', 'install']);
    });

    it('puts the old link and the old unit back when moving a stopped older install fails', async () => {
      fs.mkdirSync(path.join(paths.root, '0.2.0'), { recursive: true });
      fs.writeFileSync(path.join(paths.root, '0.2.0', 'misao.mjs'), '// node build\n');
      fs.symlinkSync('0.2.0', paths.current);
      controller.installed = true;
      controller.unit = LEGACY_UNIT;
      const original = controller.install.bind(controller);
      let calls = 0;
      controller.install = async (content: string) => {
        calls += 1;
        if (calls === 1) throw new Error('daemon-reload exploded');
        return original(content);
      };

      await expect(newService().install()).rejects.toThrow('daemon-reload exploded');

      expect(fs.readlinkSync(paths.current)).toBe('0.2.0');
      expect(controller.unit).toBe(LEGACY_UNIT);
    });

    describe('when moving a stopped older install fails after the unit is written', () => {
      function stoppedNodeEra(): void {
        fs.mkdirSync(path.join(paths.root, '0.2.0'), { recursive: true });
        fs.writeFileSync(path.join(paths.root, '0.2.0', 'misao.mjs'), '// node build\n');
        fs.symlinkSync('0.2.0', paths.current);
        controller.installed = true;
        controller.unit = LEGACY_UNIT;
      }

      it('stops the new daemon and puts back the link, the unit and .env, and does not start the old release (it was not running)', async () => {
        stoppedNodeEra();
        fs.writeFileSync(paths.hubEnvFile, 'AZITO_UI_TOKEN=abc\nMISAO_SOCKET=/old/m.sock\n');
        // The service "starts" but nothing ever listens.
        controller.start = async () => { controller.calls.push('start:new'); controller.current = 'active'; };

        await expect(newService({ readyTimeoutMs: 300 }).install({ replaceSocketSetting: true })).rejects.toMatchObject({ code: 'daemon_not_ready' });

        expect(fs.readlinkSync(paths.current)).toBe('0.2.0');
        expect(controller.unit).toBe(LEGACY_UNIT);
        expect(fs.readFileSync(paths.hubEnvFile, 'utf-8')).toBe('AZITO_UI_TOKEN=abc\nMISAO_SOCKET=/old/m.sock\n');
        expect(controller.calls.filter((c) => c.startsWith('start'))).toEqual(['start:new']);
        expect(controller.calls.slice(-2)).toEqual(['stop:0.3.0', 'install']);
        expect(controller.current).toBe('inactive');
      });

      it('removes a .env that did not exist before', async () => {
        stoppedNodeEra();
        controller.start = async () => { throw new Error('start refused'); };

        await expect(newService().install()).rejects.toThrow('start refused');

        expect(fs.existsSync(paths.hubEnvFile)).toBe(false);
        expect(fs.readlinkSync(paths.current)).toBe('0.2.0');
      });

      it('reports update_failed with what could not be restored and the manual steps when the restore fails too', async () => {
        stoppedNodeEra();
        controller.start = async () => { throw new Error('start refused'); };
        const original = controller.install.bind(controller);
        let calls = 0;
        controller.install = async (content: string) => {
          calls += 1;
          if (calls === 2) throw new Error('unit write refused');
          return original(content);
        };

        const failure = await newService().install().catch((err: unknown) => err as Error);

        expect((failure as MisaoServiceError).code).toBe('update_failed');
        expect((failure as Error).message).toContain('start refused');
        expect((failure as Error).message).toContain('the service definition: unit write refused');
        expect((failure as Error).message).toContain(`ln -sfn 0.2.0 ${paths.current}`);
      });
    });

    it('refuses to move the hub away from a MISAO_SOCKET that points at another daemon unless told to', async () => {
      fs.writeFileSync(paths.hubEnvFile, 'MISAO_SOCKET=/home/x/.misao/misao.sock\n');

      await expect(newService().install()).rejects.toMatchObject({ code: 'custom_socket' });
      expect(readEnvValue(paths.hubEnvFile, 'MISAO_SOCKET')).toBe('/home/x/.misao/misao.sock');
      expect(controller.calls).toEqual([]);

      await newService().install({ replaceSocketSetting: true });
      expect(readEnvValue(paths.hubEnvFile, 'MISAO_SOCKET')).toBe(paths.socket);
    });

    it('also asks before moving the hub off a daemon answering on the default socket (MISAO_SOCKET unset)', async () => {
      const defaultSocket = path.join(prefix, '.misao', 'misao.sock');
      fs.mkdirSync(path.dirname(defaultSocket), { recursive: true });
      const own = net.createServer();
      await new Promise<void>((resolve) => own.listen(defaultSocket, resolve));
      try {
        await expect(newService().install()).rejects.toMatchObject({ code: 'custom_socket', message: expect.stringContaining(defaultSocket) });
        expect(controller.calls).toEqual([]);

        await newService().install({ replaceSocketSetting: true });
        expect(readEnvValue(paths.hubEnvFile, 'MISAO_SOCKET')).toBe(paths.socket);
      } finally {
        await new Promise((resolve) => own.close(resolve));
      }
    });

    it('fails with a clear error when the daemon does not open its socket', async () => {
      controller.start = async () => { controller.calls.push('start'); controller.current = 'active'; };
      await expect(newService({ readyTimeoutMs: 300 }).install()).rejects.toMatchObject({ code: 'daemon_not_ready' });
    });

    it.each([
      ['a source checkout', { paths: null }],
      ['a release without misao', { bundle: null }],
      ['a host without a service manager', { controller: null }],
    ])('refuses on %s', async (_name, overrides) => {
      await expect(newService(overrides).install()).rejects.toBeInstanceOf(MisaoServiceError);
    });
  });

  describe('update', () => {
    /** A Node-era install: its directory holds `misao.mjs` (no binary) and its unit runs it with a node. */
    async function installOld(): Promise<void> {
      const oldDir = path.join(paths.root, '0.1.0');
      fs.mkdirSync(path.join(oldDir, 'node_modules', 'node-pty'), { recursive: true });
      fs.writeFileSync(path.join(oldDir, 'misao.mjs'), '// node build\n');
      fs.symlinkSync('0.1.0', paths.current);
      controller.installed = true;
      controller.unit = LEGACY_UNIT;
      controller.current = 'active';
      await controller.start();
      controller.calls.length = 0;
    }

    it('stops the old daemon, switches current, then starts the bundled one', async () => {
      await installOld();
      const status = await newService().update();

      expect(controller.calls).toEqual(['stop:0.1.0', 'install', `start:${BUNDLED_VERSION}`]);
      expect(fs.readlinkSync(paths.current)).toBe(BUNDLED_VERSION);
      expect(status).toMatchObject({ installedVersion: BUNDLED_VERSION, updateAvailable: false });
      expect(controller.unit).toContain(`${prefix}/misao/current/misao serve`);
      expect(controller.unit).not.toContain('misao.mjs');
      // The Node-era directory stays where it was (a rollback target, and not ours to delete).
      expect(fs.existsSync(path.join(paths.root, '0.1.0', 'misao.mjs'))).toBe(true);
      expect(fs.existsSync(path.join(paths.root, BUNDLED_VERSION, 'misao'))).toBe(true);
    });

    it('stops nothing when the bundled files cannot be unpacked (the daemon keeps running)', async () => {
      await installOld();
      // A directory where the binary should be copied from makes the unpack fail before anything is stopped.
      const entry = path.join(prefix, 'hub', 'current', 'misao', HOST_TARGET, 'misao');
      fs.rmSync(entry);
      fs.mkdirSync(entry);

      await expect(newService().update()).rejects.toThrow();
      expect(controller.calls).toEqual([]);
      expect(fs.readlinkSync(paths.current)).toBe('0.1.0');
    });

    describe('when the switch fails after the daemon was stopped', () => {
      /** Makes the n-th call (1-based) of a controller method fail; later calls behave normally. */
      function failCall(method: 'install' | 'start', nth: number): void {
        const original = controller[method].bind(controller);
        let calls = 0;
        controller[method] = (async (...args: [string]) => {
          calls += 1;
          if (calls === nth) throw new Error(`${method} exploded`);
          return original(...args);
        }) as never;
      }

      it('puts the previous version back and starts it when re-registering the unit fails', async () => {
        await installOld();
        failCall('install', 1);

        await expect(newService().update()).rejects.toMatchObject({ code: 'update_failed', message: expect.stringContaining('install exploded') });
        expect(fs.readlinkSync(paths.current)).toBe('0.1.0');
        expect(controller.calls.at(-1)).toBe('start:0.1.0');
        expect(controller.current).toBe('active');
        // The unit that ran before comes back as it was: rendering the new template would point a Node-era release at a binary it does not have.
        expect(controller.unit).toBe(LEGACY_UNIT);
      });

      it('puts the previous version back when start fails', async () => {
        await installOld();
        failCall('start', 1);

        await expect(newService().update()).rejects.toMatchObject({ code: 'update_failed', message: expect.stringContaining('was restored and started') });
        expect(fs.readlinkSync(paths.current)).toBe('0.1.0');
        expect(controller.current).toBe('active');
      });

      it('puts the previous version back when the new daemon never starts (service not running)', async () => {
        await installOld();
        const original = controller.start.bind(controller);
        let starts = 0;
        controller.start = async () => {
          starts += 1;
          if (starts === 1) { controller.calls.push('start:silent'); return; } // "started" but nothing listens, state stays inactive
          await original();
        };

        await expect(newService({ readyTimeoutMs: 300 }).update()).rejects.toMatchObject({ code: 'update_failed' });
        expect(fs.readlinkSync(paths.current)).toBe('0.1.0');
        expect(controller.current).toBe('active');
      });

      it('leaves a running but slow daemon alone and says how to revert by hand', async () => {
        await installOld();
        controller.start = async () => { controller.calls.push('start:slow'); controller.current = 'active'; };

        const failure = await newService({ readyTimeoutMs: 300 }).update().catch((err: unknown) => err as Error);
        expect(failure).toMatchObject({ code: 'update_failed' });
        expect((failure as Error).message).toContain('ln -sfn 0.1.0');
        expect(fs.readlinkSync(paths.current)).toBe(BUNDLED_VERSION);
        expect(controller.calls.filter((c) => c.startsWith('start'))).toEqual(['start:slow']);
      });

      it('reports both failures and the manual steps when the restore fails too', async () => {
        await installOld();
        controller.start = async () => { throw new Error('start refused'); };

        const failure = await newService().update().catch((err: unknown) => err as Error);
        expect((failure as MisaoServiceError).code).toBe('update_failed');
        expect((failure as Error).message).toContain('start refused');
        expect((failure as Error).message).toContain('restoring 0.1.0 failed too');
        expect((failure as Error).message).toContain('ln -sfn 0.1.0');
        expect((failure as Error).message).toContain('azito misao start');
        expect(fs.readlinkSync(paths.current)).toBe('0.1.0');
      });
    });

    it('does not stop a daemon that already runs the bundled version', async () => {
      const service = newService();
      await service.install();
      controller.calls.length = 0;

      await service.update();
      expect(controller.calls).toEqual([]);
    });

    it('requires an installed service', async () => {
      await expect(newService().update()).rejects.toMatchObject({ code: 'not_installed' });
    });
  });

  describe('start', () => {
    it('starts a stopped service and never restarts a running one', async () => {
      const service = newService();
      await service.install();
      await controller.stop();
      controller.calls.length = 0;

      await service.start();
      expect(controller.calls).toEqual([`start:${BUNDLED_VERSION}`]);

      controller.calls.length = 0;
      await service.start();
      expect(controller.calls).toEqual([]);
    });
  });

  describe('status', () => {
    it('reports a source checkout as unmanaged', async () => {
      const status = await newService({ paths: null }).status();
      expect(status).toMatchObject({ managed: false, unmanagedReason: 'source_install', serviceInstalled: false, updateAvailable: false, needsHubRestart: false });
    });

    it('offers an update when the running daemon is not the bundled release, using the hub-side probe', async () => {
      await newService().install();
      const status = await newService({
        hub: { socketPath: paths.socket, probeDaemon: async () => ({ reachable: true, version: '0.1.0', protocolVersion: '0.2.0' }) },
      }).status();
      expect(status.updateAvailable).toBe(true);
      expect(status.daemon.version).toBe('0.1.0');
    });

    it('offers an update when the daemon speaks an incompatible protocol', async () => {
      await newService().install();
      const status = await newService({
        hub: { socketPath: paths.socket, probeDaemon: async () => ({ reachable: false, detail: 'protocol_incompatible' }) },
      }).status();
      expect(status.updateAvailable).toBe(true);
    });

    it('asks for a hub restart when the hub still uses another socket than the one installed', async () => {
      await newService().install();
      const status = await newService({
        hub: { socketPath: '/home/x/.misao/misao.sock', probeDaemon: async () => ({ reachable: false }) },
      }).status();
      expect(status.needsHubRestart).toBe(true);
    });

    it('does not start, stop or install anything', async () => {
      await newService().status();
      expect(controller.calls).toEqual([]);
    });
  });
});

describe('readMisaoBundle', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'azb-')); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('is null when the hub carries no misao', () => {
    expect(readMisaoBundle(null)).toBeNull();
    expect(readMisaoBundle(root)).toBeNull();
  });

  it('rejects a damaged binary instead of installing it', () => {
    writeHubBundle(root);
    fs.writeFileSync(path.join(root, 'misao', HOST_TARGET, 'misao'), '// tampered\n');
    expect(() => readMisaoBundle(root)).toThrow(/does not match its manifest sha256/);
  });

  it('rejects a bundle that lacks one of the targets', () => {
    writeHubBundle(root);
    fs.rmSync(path.join(root, 'misao', 'aarch64-apple-darwin'), { recursive: true });
    expect(() => readMisaoBundle(root)).toThrow(/aarch64-apple-darwin/);
  });

  it('reads the files of every target', () => {
    writeHubBundle(root);
    const bundle = readMisaoBundle(root)!;
    expect(Object.keys(bundle.targets).sort()).toEqual(['aarch64-apple-darwin', 'aarch64-unknown-linux-musl', 'x86_64-apple-darwin', 'x86_64-unknown-linux-musl']);
  });
});
