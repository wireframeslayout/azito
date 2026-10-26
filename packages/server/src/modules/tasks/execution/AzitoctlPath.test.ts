import { describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../../servers/Server';
import { resolveAzitoctlPath, resolveEnvelopeHost } from './AzitoctlPath';
import { harnessLocation } from '../../servers/agent-deploy/harnessLocation';
import { remoteHarnessDir } from '../../servers/agent-deploy/HarnessInstaller';

const agent = { name: 'srv', type: 'agent' } as ServerConfig;
const local = { name: 'local', type: 'local' } as ServerConfig;

function factory(platform: 'linux' | 'win32' | null, home = '/home/me', nodePath = 'C:\\Program Files\\nodejs\\node.exe', exists: (p: string) => boolean = () => true) {
  return {
    hostProfileFor: vi.fn(() => (platform ? { platform, arch: 'x64' as const } : null)),
    getFileOps: vi.fn(() => ({ platform: platform ?? 'linux', realpath: vi.fn(async () => home), stat: vi.fn(async (p: string) => (exists(p) ? {} : null)) })),
    getAgentTransport: vi.fn(() => ({ fetchNodeExecPath: vi.fn(async () => nodePath) })),
  } as unknown as Parameters<typeof resolveEnvelopeHost>[0];
}

describe('resolveEnvelopeHost', () => {
  it('a POSIX host (or one whose OS is not recorded) gets the bash azitoctl, as before', async () => {
    expect(await resolveEnvelopeHost(factory('linux'), agent, '')).toEqual({ os: 'posix', azitoctl: '~/.azito/harness/bin/azitoctl' });
    expect(await resolveEnvelopeHost(factory(null), agent, '')).toEqual({ os: 'posix', azitoctl: '~/.azito/harness/bin/azitoctl' });
    expect(await resolveEnvelopeHost(factory('linux'), local, '')).toEqual({ os: 'posix', azitoctl: resolveAzitoctlPath(local, '') });
  });

  it("a POSIX agent's azitoctl is in the prefixed harness folder the SSH install (remoteHarnessDir) wrote", async () => {
    expect(await resolveEnvelopeHost(factory('linux'), agent, 'w806rc')).toEqual({ os: 'posix', azitoctl: '~/.azito/harness-w806rc/bin/azitoctl' });
    expect(await resolveEnvelopeHost(factory(null), agent, 'w806rc')).toEqual({ os: 'posix', azitoctl: '~/.azito/harness-w806rc/bin/azitoctl' });
    // the install and the prompt name the same folder, from the real functions
    for (const prefix of ['', 'w806rc']) {
      expect(resolveAzitoctlPath(agent, prefix)).toBe(`${remoteHarnessDir(prefix || undefined)}/bin/azitoctl`);
    }
  });

  it.each([
    ['a POSIX agent', 'linux' as const, '/home/me', 'azitoctl'],
    ['a Windows agent', 'win32' as const, 'C:\\Users\\me', 'azitoctl.mjs'],
  ])('%s that has only the unprefixed harness fails at once, telling to install it again (no fallback to the unprefixed folder)', async (_name, platform, home, script) => {
    const onlyUnprefixed = (p: string) => /[\\/]harness[\\/]/.test(p);
    const tf = factory(platform, home, undefined, onlyUnprefixed);
    await expect(resolveEnvelopeHost(tf, agent, 'w806rc')).rejects.toThrow(new RegExp(`prefix "w806rc".*"srv".*harness-w806rc.*${script.replace('.', '\\.')}.*Install the harness again from Setup, or check the permissions`));
    // the same host is fine for a hub without a prefix
    await expect(resolveEnvelopeHost(tf, agent, '')).resolves.toMatchObject({ os: platform === 'win32' ? 'windows' : 'posix' });
  });

  it('a query that fails is reported as such, not as a missing harness', async () => {
    const tf = factory('linux', '/home/me', undefined, () => { throw new Error('stat gave no usable output'); });
    const err = await resolveEnvelopeHost(tf, agent, 'w806rc').catch((e: Error) => e);
    expect((err as Error).message).toMatch(/Could not check whether this hub's harness is installed.*stat gave no usable output/);
    expect((err as Error).message).not.toMatch(/Install the harness again/);
  });

  it('the hub\'s own server is not checked (no prefixed copy is ever installed there)', async () => {
    const tf = factory('linux', '/home/me', undefined, () => false);
    await expect(resolveEnvelopeHost(tf, local, 'w806rc')).resolves.toMatchObject({ os: 'posix' });
    expect(tf.getFileOps).not.toHaveBeenCalled();
  });

  it("the hub's own server runs the hub's harness whatever the prefix is (setup there is never copied to a prefixed folder)", async () => {
    expect(resolveAzitoctlPath(local, 'w806rc')).toBe(resolveAzitoctlPath(local, ''));
    expect((await resolveEnvelopeHost(factory('linux'), local, 'w806rc')).azitoctl).toBe(resolveAzitoctlPath(local, ''));
  });

  it("a Windows agent gets the agent's own node.exe and its harness's azitoctl.mjs, both by full path with forward slashes", async () => {
    const host = await resolveEnvelopeHost(factory('win32', 'C:\\Users\\山田 太郎'), agent, '');
    expect(host).toEqual({ os: 'windows', azitoctl: '"C:/Program Files/nodejs/node.exe" "C:/Users/山田 太郎/.azito/harness/bin/azitoctl.mjs"' });
  });

  it.each(['', 'w806rc'])("a Windows agent's azitoctl.mjs is where the harness install puts it (harness prefix %j)", async (prefix) => {
    const home = 'C:\\Users\\me';
    const host = await resolveEnvelopeHost(factory('win32', home), agent, prefix);
    const installed = harnessLocation('win32', home, prefix || undefined).harnessDir.replace(/\\/g, '/');
    expect(host.azitoctl).toBe(`"C:/Program Files/nodejs/node.exe" "${installed}/bin/azitoctl.mjs"`);
    expect(host.azitoctl).toContain(prefix ? `/.azito/harness-${prefix}/bin/` : '/.azito/harness/bin/');
  });

  it("a Windows hub's own server gets the hub's harness, not the agent's home", async () => {
    const tf = factory('win32', 'C:\\Users\\me');
    const host = await resolveEnvelopeHost(tf, local, '');
    expect(host.os).toBe('windows');
    // The hub's own node (the bundled node.exe of a Windows hub), not a bare `node` that may not be on the worker's PATH.
    expect(host.azitoctl).toBe(`"${process.execPath.replace(/\\/g, '/')}" "${host.azitoctl.split('" "')[1]}`);
    expect(host.azitoctl).toMatch(/\/harness\/bin\/azitoctl\.mjs"$/);
    expect(host.azitoctl).not.toContain('\\');
    expect(tf.getFileOps).not.toHaveBeenCalled();
  });

  it('refuses a home directory a double-quoted word would read as more than text', async () => {
    await expect(resolveEnvelopeHost(factory('win32', 'C:\\Users\\jo$e'), agent, '')).rejects.toThrow(/double quote, \$ or a backtick/);
    await expect(resolveEnvelopeHost(factory('win32', 'C:\\Users\\me', 'C:\\no`de\\node.exe'), agent, '')).rejects.toThrow(/node executable/);
  });
});
