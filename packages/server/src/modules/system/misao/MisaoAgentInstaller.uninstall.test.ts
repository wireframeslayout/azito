import { describe, expect, it, vi } from 'vitest';
import { MisaoAgentInstaller } from './MisaoAgentInstaller';

function fake(answer: string) {
  const exec = vi.fn(async (command: string) => {
    if (command.includes('echo SHARED')) return { code: 0, stdout: answer, stderr: '' };
    if (command.startsWith("'/usr/bin/node' -e ")) return { code: 0, stdout: 'STOPPED\n', stderr: '' };
    if (command.startsWith('readlink ')) return { code: 0, stdout: 'v1.0.0\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  });
  const target = { hostProfile: { platform: 'darwin', arch: 'arm64' }, fetchMisaoStatus: async () => ({ socketPath: '/Users/me/.azito/misao/misao.sock', installedVersion: 'v1.0.0', host: { homeDir: '/Users/me', nodePath: '/usr/bin/node', servicePath: '/usr/bin:/bin', platform: 'darwin', arch: 'arm64' } }), exec };
  return { target, exec };
}

describe('Mac agent misao removal', () => {
  it('leaves a potentially shared hub daemon in place', async () => {
    const { target, exec } = fake('SHARED\n');
    await expect(new MisaoAgentInstaller(null).uninstallMac(target as never)).resolves.toBe('skipped');
    expect(exec.mock.calls.every((call) => !call[0].includes('rm -rf'))).toBe(true);
  });
  it('reports an absent installation', async () => {
    const { target } = fake('ABSENT\n');
    await expect(new MisaoAgentInstaller(null).uninstallMac(target as never)).resolves.toBe('absent');
  });
  it('removes a verified managed installation once the socket is down', async () => {
    const { target, exec } = fake('PRESENT\n');
    await expect(new MisaoAgentInstaller(null).uninstallMac(target as never)).resolves.toBe('done');
    expect(exec.mock.calls.some((call) => call[0].includes('rm -rf'))).toBe(true);
  });
  it('leaves files when the socket probe cannot run', async () => {
    const { target, exec } = fake('PRESENT\n');
    const original = exec.getMockImplementation()!;
    exec.mockImplementation(async (command: string) => command.startsWith("'/usr/bin/node' -e ") ? { code: 127, stdout: '', stderr: 'node missing' } : original(command));
    await expect(new MisaoAgentInstaller(null).uninstallMac(target as never)).rejects.toThrow(/probe misao failed/);
    expect(exec.mock.calls.every((call) => !call[0].includes('rm -rf'))).toBe(true);
  });
  it('refuses a linked or unrecognized misao directory', async () => {
    const { target, exec } = fake('FOREIGN\n');
    await expect(new MisaoAgentInstaller(null).uninstallMac(target as never)).rejects.toThrow(/not a managed installation/);
    expect(exec.mock.calls.every((call) => !call[0].includes('rm -rf'))).toBe(true);
  });
});
