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

async function loadWithHubPath(hubPath: typeof path): Promise<{
  socketModule: typeof import('../../servers/transport/agentMisaoSocket.js');
  installerModule: typeof import('./MisaoAgentInstaller.js');
}> {
  vi.resetModules();
  vi.doMock('path', () => ({ ...hubPath, default: hubPath }));
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
    vi.resetModules();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('only sends POSIX paths to a Linux agent (current link, binary, staging, unit file, log)', async () => {
    const { installerModule } = await loadWithHubPath(path.win32);
    const scripts: string[] = [];
    const status: MisaoSocketStatus = { socketPath: SOCKET, socketPresent: false, host };
    const target = {
      hostProfile: { platform: 'linux', arch: 'x64' },
      fetchMisaoStatus: async () => status,
      uploadMisaoFile: async (_version: string, _name: string, data: Buffer) => ({ size: data.length, sha256: (await import('crypto')).createHash('sha256').update(data).digest('hex') }),
      exec: async (command: string) => {
        scripts.push(command);
        // The probe finds no daemon; everything else "works".
        return { code: command.includes('/usr/bin/node') ? 1 : 0, stdout: '', stderr: '' };
      },
    } as unknown as MisaoInstallTarget;

    const installer = new installerModule.MisaoAgentInstaller(bundle, { readyTimeoutMs: 50, pollIntervalMs: 10 });
    // How far it gets does not matter (the hub's own template file is not readable under a swapped `path` on Linux).
    await installer.install(target).catch(() => undefined);

    const text = scripts.join('\n');
    expect(text).toContain(`'${ROOT}/current'`);
    expect(text).toContain(`${ROOT}/0.3.0`);
    expect(text).toContain(`${ROOT}/0.3.0.upload`);
    expect(text).not.toMatch(/\\home|\\\.azito|\\misao|\\current/);
  });

  it('refuses a managed socket spelled with the hub\'s separators, naming the POSIX one', async () => {
    const { installerModule } = await loadWithHubPath(path.win32);
    const status: MisaoSocketStatus = { socketPath: '/home/w851/.azito/misao/other.sock', socketPresent: false, host };
    const target = { hostProfile: { platform: 'linux', arch: 'x64' }, fetchMisaoStatus: async () => status, exec: async () => ({ code: 1, stdout: '', stderr: '' }) } as unknown as MisaoInstallTarget;
    const installer = new installerModule.MisaoAgentInstaller(bundle);
    await expect(installer.install(target)).rejects.toThrow(`not the managed socket ${SOCKET}`);
  });
});
