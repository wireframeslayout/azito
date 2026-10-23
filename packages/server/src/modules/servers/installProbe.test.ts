import { describe, expect, it } from 'vitest';
import { probeOutput, resolveOsName } from './installProbe';
import type { IServerTransport } from './transport/ServerTransport';
import { CommandSpawnError, CommandTimeoutError } from '../../shared/exec/commandSpec';
import { failed, fakeRunTransport, ok } from '../../shared/exec/testing/commandTesting';

describe('probeOutput', () => {
  it('runs the program with its arguments and returns its stdout', async () => {
    const t = fakeRunTransport(() => ok('v24.14.0\n'));
    expect(await probeOutput(t, 'node', ['--version'])).toBe('v24.14.0\n');
    expect(t.specs[0]).toMatchObject({ file: 'node', args: ['--version'] });
  });

  it('answers nothing for a program that exits non-zero, even if it printed something', async () => {
    expect(await probeOutput(fakeRunTransport(() => failed(1, 'e', 'partial')), 'tailscale', ['ip', '-4'])).toBe('');
  });

  it('answers nothing for a program that is not installed', async () => {
    const t = { run: async () => { throw new CommandSpawnError('ENOENT', 'spawn tailscale ENOENT'); } } as unknown as IServerTransport;
    expect(await probeOutput(t, 'tailscale', ['ip', '-4'])).toBe('');
  });

  it('throws what is not an answer about the program (timeout, a program that exists but cannot run)', async () => {
    const slow = { run: async () => { throw new CommandTimeoutError(10_000, '', ''); } } as unknown as IServerTransport;
    await expect(probeOutput(slow, 'node', ['--version'])).rejects.toBeInstanceOf(CommandTimeoutError);
    const denied = { run: async () => { throw new CommandSpawnError('EACCES', 'spawn node EACCES'); } } as unknown as IServerTransport;
    await expect(probeOutput(denied, 'node', ['--version'])).rejects.toMatchObject({ code: 'EACCES' });
  });
});

describe('resolveOsName', () => {
  it.each([
    [{ platform: 'darwin', arch: 'arm64' } as const, 'Darwin'],
    [{ platform: 'linux', arch: 'x64' } as const, 'Linux'],
    [{ platform: 'win32', arch: 'x64' } as const, 'Windows_NT'],
  ])('takes the OS from the recorded host %o without probing', async (profile, expected) => {
    const t = fakeRunTransport();
    expect(await resolveOsName(t, profile)).toBe(expected);
    expect(t.specs).toHaveLength(0);
  });

  it('probes `uname -s` only when no host is recorded', async () => {
    const t = fakeRunTransport(() => ok('Darwin\n'));
    expect(await resolveOsName(t, null)).toBe('Darwin');
    expect(t.specs[0]).toMatchObject({ file: 'uname', args: ['-s'] });
  });
});
