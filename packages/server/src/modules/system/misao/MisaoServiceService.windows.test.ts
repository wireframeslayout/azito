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

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azw-'));
    const root = path.join(dir, 'misao');
    paths = { prefix: dir, root, current: path.join(root, 'current'), socket: PIPE, log: path.join(root, 'misao.log'), hubEnvFile: path.join(dir, 'hub', '.env') };
    fs.mkdirSync(path.join(dir, 'hub'), { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    taskExists = false;
    exportedXml = taskXml(path.win32.normalize(root));
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
    exportedXml = taskXml(path.win32.normalize(paths.root).toUpperCase());
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

  it('reads the installed version from the current file, and is not installed without the task', async () => {
    fs.writeFileSync(paths.current, '0.3.0\n');
    expect(service().installedVersion()).toBe('0.3.0');
    expect(await service().status()).toMatchObject({ serviceInstalled: false, installedVersion: '0.3.0' });
    fs.writeFileSync(paths.current, 'garbage');
    expect(service().installedVersion()).toBeUndefined();
  });

  it('reports an update when the installed release is not the bundled one', async () => {
    taskExists = true;
    fs.writeFileSync(paths.current, '0.2.0\n');
    expect(await service().status()).toMatchObject({ serviceInstalled: true, updateAvailable: true });
  });
});
