import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMisaoHost, MisaoSocketStatus } from '../../servers/transport/agentMisaoSocket';
import { readMisaoBundle, type MisaoBundle } from './MisaoBundle';
import { writeHubBundle } from './misaoBundleFixture';
import type { MisaoInstallTarget } from './misaoInstallTypes';

/**
 * The paths of a Unix agent are POSIX whatever OS the hub runs on. On a Windows hub `path` is `path.win32`, which joins
 * with `\`; here `path` is swapped for it so the same thing is checked on every CI runner (the Windows runner needs no swap).
 */

const HOME = '/home/w851';
const ROOT = '/home/w851/.azito/misao';
const SOCKET = `${ROOT}/misao.sock`;

const host: AgentMisaoHost = { homeDir: HOME, nodePath: '/usr/bin/node', servicePath: '/usr/bin:/bin', platform: 'linux', arch: 'x64' };

async function loadWithHubPath(hubPath: typeof path, hubDir?: string): Promise<{
  socketModule: typeof import('../../servers/transport/agentMisaoSocket.js');
  installerModule: typeof import('./MisaoAgentInstaller.js');
}> {
  vi.resetModules();
  vi.doMock('path', () => ({ ...hubPath, default: hubPath }));
  if (hubDir !== undefined) {
    // The hub's own template file: under a swapped `path` on Linux its join is `\\tmp\\...`, which no file system here resolves.
    const realFs = await vi.importActual<typeof import('fs')>('fs');
    const readFileSync = ((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => (
      typeof file === 'string' && /azito-misao\.service$/.test(file)
        ? realFs.readFileSync(path.join(hubDir, 'hub', 'deploy', 'azito-misao.service'), ...(rest as [BufferEncoding]))
        : realFs.readFileSync(file, ...(rest as [BufferEncoding]))
    )) as typeof fs.readFileSync;
    vi.doMock('fs', () => ({ ...realFs, readFileSync, default: { ...realFs, readFileSync } }));
  }
  const socketModule = await import('../../servers/transport/agentMisaoSocket.js');
  const installerModule = await import('./MisaoAgentInstaller.js');
  return { socketModule, installerModule };
}

describe.each([
  ['a win32 hub', path.win32],
  ['a POSIX hub', path.posix],
])('the paths of a Linux agent, seen from %s', (_name, hubPath) => {
  afterEach(() => {
    vi.doUnmock('path');
    vi.resetModules();
  });

  it('agentMisaoRoot / agentMisaoManagedSocket are POSIX paths', async () => {
    const { socketModule } = await loadWithHubPath(hubPath);
    expect(socketModule.agentMisaoRoot(HOME)).toBe(ROOT);
    expect(socketModule.agentMisaoManagedSocket(HOME)).toBe(SOCKET);
    expect(socketModule.managedEndpointOf(host)).toBe(SOCKET);
    expect(socketModule.misaoRootOf(host)).toBe(ROOT);
  });
});

describe('MisaoAgentInstaller on a win32 hub', () => {
  let tmp: string;
  let bundle: MisaoBundle;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'azmi-rp-'));
    writeHubBundle(path.join(tmp, 'hub'), '0.3.0', '#!/bin/sh\n');
    bundle = readMisaoBundle(path.join(tmp, 'hub'))!;
  });

  afterEach(() => {
    vi.doUnmock('path');
    vi.doUnmock('fs');
    vi.resetModules();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * A fake agent: records every script sent; the probe finds no daemon until a start command has gone out, and
   * `failSystemd` makes `systemctl --user start` fail so the background-process path is taken.
   */
  async function install(failSystemd: boolean): Promise<{ scripts: string[]; startMethod: string }> {
    const { installerModule } = await loadWithHubPath(path.win32, tmp);
    const scripts: string[] = [];
    let started = false;
    const status: MisaoSocketStatus = { socketPath: SOCKET, socketPresent: false, host };
    const target = {
      hostProfile: { platform: 'linux', arch: 'x64' },
      fetchMisaoStatus: async () => status,
      uploadMisaoFile: async (_version: string, _name: string, data: Buffer) => ({ size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') }),
      exec: async (command: string) => {
        if (command.startsWith("'/usr/bin/node' -e")) return { code: started ? 0 : 1, stdout: '', stderr: '' };
        scripts.push(command);
        if (command.includes('systemctl --user start')) {
          if (failSystemd) return { code: 1, stdout: '', stderr: 'no user bus' };
          started = true;
        }
        if (command.includes('nohup')) started = true;
        return { code: 0, stdout: '', stderr: '' };
      },
    } as unknown as MisaoInstallTarget;
    const installer = new installerModule.MisaoAgentInstaller(bundle, { readyTimeoutMs: 500, pollIntervalMs: 10 });
    const result = await installer.install(target);
    return { scripts, startMethod: result.startMethod };
  }

  function expectNoHubSeparators(text: string): void {
    expect(text).not.toMatch(/\\home|\\\.azito|\\misao|\\current/);
  }

  it('only sends POSIX paths to a Linux agent started by systemd (current link, staging, unit file and its ExecStart)', async () => {
    const { scripts, startMethod } = await install(false);
    expect(startMethod).toBe('systemd');

    const text = scripts.join('\n');
    expect(text).toContain(`'${ROOT}/current'`);
    expect(text).toContain(`${ROOT}/0.3.0.upload`);
    expect(text).toContain("mkdir -p '/home/w851/.config/systemd/user'");
    expectNoHubSeparators(text);

    const encoded = /printf %s '([A-Za-z0-9+/=]+)' \| base64 -d/.exec(text)?.[1];
    expect(encoded).toBeDefined();
    const unit = Buffer.from(encoded!, 'base64').toString('utf-8');
    expect(unit).toContain(`ExecStart=/home/w851/.azito/misao/current/misao serve --socket ${SOCKET} --data ${ROOT}`);
    expectNoHubSeparators(unit);
  });

  it('only sends POSIX paths to a Linux agent started as a background process (binary, log)', async () => {
    const { scripts, startMethod } = await install(true);
    expect(startMethod).toBe('nohup');

    const text = scripts.join('\n');
    expect(text).toContain(`-x '${ROOT}/current/misao'`);
    expect(text).toContain(`'${ROOT}/current/misao.mjs'`);
    expect(text).toContain(`>> '${ROOT}/misao.log'`);
    expectNoHubSeparators(text);
  });

  it('refuses a managed socket spelled with the hub\'s separators, naming the POSIX one', async () => {
    const { installerModule } = await loadWithHubPath(path.win32);
    const status: MisaoSocketStatus = { socketPath: '/home/w851/.azito/misao/other.sock', socketPresent: false, host };
    const target = { hostProfile: { platform: 'linux', arch: 'x64' }, fetchMisaoStatus: async () => status, exec: async () => ({ code: 1, stdout: '', stderr: '' }) } as unknown as MisaoInstallTarget;
    const installer = new installerModule.MisaoAgentInstaller(bundle);
    await expect(installer.install(target)).rejects.toThrow(`not the managed socket ${SOCKET}`);
  });
});
