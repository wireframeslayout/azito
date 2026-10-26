import { describe, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../../servers/Server';
import { resolveAzitoctlPath, resolveEnvelopeHost } from './AzitoctlPath';
import { harnessLocation } from '../../servers/agent-deploy/harnessLocation';

const agent = { name: 'srv', type: 'agent' } as ServerConfig;
const local = { name: 'local', type: 'local' } as ServerConfig;

function factory(platform: 'linux' | 'win32' | null, home = '/home/me', nodePath = 'C:\\Program Files\\nodejs\\node.exe') {
  return {
    hostProfileFor: vi.fn(() => (platform ? { platform, arch: 'x64' as const } : null)),
    getFileOps: vi.fn(() => ({ realpath: vi.fn(async () => home) })),
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
