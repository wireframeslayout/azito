import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MisaoAgentInstallResult } from './misaoInstallTypes';
import type { MisaoBundle } from './MisaoBundle';
import type { LocalMisaoWindows } from './misaoLocalWindows';
import type { MisaoPaths } from './misaoPaths';
import { MisaoServiceError } from './MisaoServiceError';
import { MisaoServiceService } from './MisaoServiceService';
import { readEnvValue } from '../../../shared/envFile';
import { ProcessLock } from '../../../shared/processLock';
import { createSecretFileGuard } from '../../../shared/os/secretFileGuard';
import type { ServiceManager } from '../serviceManager';

/**
 * The Windows branch of the service (its steps are the agent installer's, tested in MisaoAgentInstaller.windows.test.ts and, on a
 * real Windows, MisaoWindowsInstaller.misaoIntegration.test.ts): what the service adds is the guards around it and the hub's `.env`.
 * Everything is in a temp folder, so this runs on any OS; the pipe name is only a string here.
 */

const PIPE = '\\\\.\\pipe\\misao-test-0123456789abcdef';
const BUNDLE = { version: '0.3.0', dir: '', templatesDir: '', targets: {} } as unknown as MisaoBundle;
const RESULT: MisaoAgentInstallResult = { version: '0.3.0', runningVersion: '0.3.0', startMethod: 'taskscheduler', updateAvailable: false };

function taskXml(root: string): string {
  return `<Task><Actions><Exec><Command>conhost.exe</Command><Arguments>--headless cmd.exe /d /c ""${root}\\0.3.0\\misao.exe" serve --data "${root}""</Arguments></Exec></Actions></Task>`;
}

describe('MisaoServiceService on Windows (the hub\'s own misao)', () => {
  let dir: string;
  let paths: MisaoPaths;
  let taskExists: boolean;
  let exportedXml: string;
  let windows: LocalMisaoWindows;
  let install: ReturnType<typeof vi.fn>;
  let update: ReturnType<typeof vi.fn>;
  let controller: ServiceManager;
  let controllerInstall: ReturnType<typeof vi.fn>;
  /** The processes of the fake host: id -> start time. This one is 100; the CLI is 200. */
  let processes: Map<number, string>;
  const lockFor = (pid: number): ProcessLock => new ProcessLock(path.join(paths.root, '.operation.lock'), { pid, exists: (p) => processes.has(p), readStart: async (p) => processes.get(p) ?? null });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azw-'));
    const root = path.join(dir, 'misao');
    paths = { prefix: dir, root, current: path.join(root, 'current'), socket: PIPE, log: path.join(root, 'misao.log'), hubEnvFile: path.join(dir, 'hub', '.env') };
    fs.mkdirSync(path.join(dir, 'hub'), { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    processes = new Map([[100, 'hub'], [200, 'cli']]);
    taskExists = false;
    exportedXml = taskXml(root);
    install = vi.fn(async () => RESULT);
    update = vi.fn(async () => RESULT);
    windows = {
      installer: { install, update } as unknown as LocalMisaoWindows['installer'],
      target: {} as unknown as LocalMisaoWindows['target'],
      tasks: {
        query: async () => ({ exists: taskExists, running: false }),
        exportXml: async () => exportedXml,
      } as unknown as LocalMisaoWindows['tasks'],
      taskName: 'AzitoMisao',
      operationLock: lockFor(100),
    };
    controllerInstall = vi.fn();
    controller = {
      kind: 'taskscheduler',
      templateName: undefined,
      isInstalled: () => false,
      readDefinition: () => undefined,
      install: controllerInstall,
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
      reload: vi.fn(),
      inspect: async () => ({ state: 'inactive', domains: [] }),
      state: async () => 'inactive',
      loadedDomain: async () => undefined,
    } as unknown as ServiceManager;
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const service = (): MisaoServiceService => new MisaoServiceService({
    paths,
    bundle: BUNDLE,
    controller,
    env: {},
    secretFileGuard: createSecretFileGuard(process.platform, process.env),
    windows,
  });

  it('installs through the agent installer aimed at this machine, then points the hub at the pipe', async () => {
    taskExists = true;
    fs.writeFileSync(paths.current, '0.3.0\r\n');
    const status = await service().install();
    expect(install).toHaveBeenCalledWith(windows.target, BUNDLE, expect.any(Function));
    expect(readEnvValue(paths.hubEnvFile, 'MISAO_SOCKET')).toBe(PIPE);
    expect(status).toMatchObject({ serviceManager: 'taskscheduler', serviceInstalled: true, installedVersion: '0.3.0', socketPath: PIPE, socketSetting: 'managed' });
  });

  it('never writes a unit or a definition through the service manager (the installer registers the task itself)', async () => {
    await service().install();
    expect(controllerInstall).not.toHaveBeenCalled();
  });

  it('leaves the hub .env alone when the install fails', async () => {
    install.mockRejectedValue(new MisaoServiceError('daemon_not_ready', 'pipe not up'));
    await expect(service().install()).rejects.toMatchObject({ code: 'daemon_not_ready' });
    expect(fs.existsSync(paths.hubEnvFile)).toBe(false);
  });

  it('refuses to move the hub away from another daemon unless asked to', async () => {
    fs.writeFileSync(paths.hubEnvFile, 'MISAO_SOCKET=\\\\.\\pipe\\someone-else\n');
    await expect(service().install()).rejects.toMatchObject({ code: 'custom_socket' });
    expect(install).not.toHaveBeenCalled();
    await service().install({ replaceSocketSetting: true });
    expect(readEnvValue(paths.hubEnvFile, 'MISAO_SOCKET')).toBe(PIPE);
  });

  it('refuses a task that starts a misao from another folder (one task per user), unless asked to', async () => {
    taskExists = true;
    exportedXml = taskXml('D:\\other\\.azito\\misao');
    await expect(service().install()).rejects.toMatchObject({ code: 'custom_socket', message: expect.stringContaining('another folder') });
    expect(install).not.toHaveBeenCalled();
    await service().install({ replaceSocketSetting: true });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('takes over a task of its own folder without asking (letter case does not matter)', async () => {
    taskExists = true;
    exportedXml = taskXml(paths.root.toUpperCase());
    await service().install();
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('refuses to update what is not installed, and updates through the installer when it is', async () => {
    await expect(service().update()).rejects.toMatchObject({ code: 'not_installed' });
    taskExists = true;
    fs.writeFileSync(paths.current, '0.2.0\n');
    await service().update();
    expect(update).toHaveBeenCalledWith(windows.target, BUNDLE, expect.any(Function));
  });

  it('does not update or start a task that starts a misao from another folder (only install --replace-socket moves it)', async () => {
    taskExists = true;
    fs.writeFileSync(paths.current, '0.2.0\n');
    exportedXml = taskXml('D:\\other\\.azito\\misao');
    await expect(service().update()).rejects.toMatchObject({ code: 'custom_socket', message: expect.stringContaining('another folder') });
    await expect(service().start()).rejects.toMatchObject({ code: 'custom_socket' });
    expect(update).not.toHaveBeenCalled();
    expect(controller.start).not.toHaveBeenCalled();
  });

  it('asks the Task Scheduler once per status', async () => {
    taskExists = true;
    fs.writeFileSync(paths.current, '0.3.0\n');
    const query = vi.fn(async () => ({ exists: true, running: true, failed: false, lastResult: 0x41301 }));
    windows = { ...windows, tasks: { query, exportXml: async () => exportedXml } as unknown as LocalMisaoWindows['tasks'] };
    expect(await service().status()).toMatchObject({ serviceInstalled: true, serviceState: 'active' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('reads the installed version from the current file, and is not installed without the task', async () => {
    fs.writeFileSync(paths.current, '0.3.0\n');
    expect(service().installedVersion()).toBe('0.3.0');
    expect(await service().status()).toMatchObject({ serviceInstalled: false, installedVersion: '0.3.0' });
    fs.writeFileSync(paths.current, 'garbage');
    expect(service().installedVersion()).toBeUndefined();
  });

  describe('bringing the daemon back (LocalMisaoWatchdog)', () => {
    let revive: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      revive = vi.fn(async () => 'started');
      windows = { ...windows, installer: { install, update, reviveDaemon: revive } as unknown as LocalMisaoWindows['installer'] };
      fs.writeFileSync(paths.hubEnvFile, `MISAO_SOCKET=${PIPE}\n`);
      taskExists = true;
    });

    it('revives through the agent installer\'s own steps for the task of this folder, with the force flag it was given', async () => {
      expect(await service().reviveWindowsDaemon(false)).toBe('started');
      expect(await service().reviveWindowsDaemon(true)).toBe('started');
      expect(revive.mock.calls).toEqual([[windows.target, false], [windows.target, true]]);
    });

    it('leaves a misao the hub was pointed at by hand alone (MISAO_SOCKET is not the managed pipe, or is not set)', async () => {
      fs.writeFileSync(paths.hubEnvFile, 'MISAO_SOCKET=\\\\.\\pipe\\someone-else\n');
      expect(await service().reviveWindowsDaemon(false)).toBe('custom_socket');
      fs.rmSync(paths.hubEnvFile);
      expect(await service().reviveWindowsDaemon(false)).toBe('custom_socket');
      expect(revive).not.toHaveBeenCalled();
    });

    it('leaves a task that starts another folder\'s misao alone', async () => {
      exportedXml = taskXml('D:\\other\\.azito\\misao');
      expect(await service().reviveWindowsDaemon(true)).toBe('other_task');
      expect(revive).not.toHaveBeenCalled();
    });

    it('gives way to an install / update that holds the slot (busy, nothing done) and takes the slot itself', async () => {
      const svc = service();
      let release!: () => void;
      update.mockImplementation(() => new Promise<MisaoAgentInstallResult>((resolve) => { release = () => resolve(RESULT); }));
      fs.writeFileSync(paths.current, '0.2.0\n');
      const updating = svc.update();
      await vi.waitFor(() => expect(update).toHaveBeenCalled());
      expect(await svc.reviveWindowsDaemon(false)).toBe('busy');
      expect(revive).not.toHaveBeenCalled();
      release();
      await updating;
      expect(await svc.reviveWindowsDaemon(false)).toBe('started');
    });

    it('does nothing while the CLI (another process) is installing / updating: busy, and the CLI\'s update is refused the other way round', async () => {
      const cli = lockFor(200);
      let during: string | undefined;
      await cli.run(async () => {
        during = await service().reviveWindowsDaemon(true);
        await expect(service().update()).rejects.toMatchObject({ code: 'busy', message: expect.stringContaining('(200)') });
      });
      expect(during).toBe('busy');
      expect(revive).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      // The slot is free again once the other process is done (and a dead holder does not keep it).
      expect(await service().reviveWindowsDaemon(false)).toBe('started');
      await cli.run(async () => undefined);
      fs.writeFileSync(path.join(paths.root, '.operation.lock'), JSON.stringify({ pid: 300, started: 'gone' }));
      expect(await service().reviveWindowsDaemon(false)).toBe('started');
    });

    it('is only for a Windows hub with a managed misao', () => {
      expect(service().managesWindowsDaemon()).toBe(true);
      const withoutWindows = new MisaoServiceService({ paths, bundle: BUNDLE, controller, env: {}, secretFileGuard: createSecretFileGuard(process.platform, process.env) });
      expect(withoutWindows.managesWindowsDaemon()).toBe(false);
      expect(new MisaoServiceService({ paths: null, bundle: BUNDLE, controller, env: {}, secretFileGuard: createSecretFileGuard(process.platform, process.env), windows }).managesWindowsDaemon()).toBe(false);
    });
  });

  it('reports an update when the installed release is not the bundled one', async () => {
    taskExists = true;
    fs.writeFileSync(paths.current, '0.2.0\n');
    expect(await service().status()).toMatchObject({ serviceInstalled: true, updateAvailable: true });
  });
});
