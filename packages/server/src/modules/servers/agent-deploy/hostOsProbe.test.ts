import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { HOST_OS_PROBE_COMMAND, parseHostOsProbe } from './hostOsProbe';

const isWindows = process.platform === 'win32';

describe('parseHostOsProbe (the output of the OS probe, one fixed example per login shell)', () => {
  it('reads sh as a POSIX host, whatever status `$?` carries', () => {
    expect(parseHostOsProbe('AZITO_OS:%OS%:0\n')).toEqual({ os: 'posix', loginShell: 'sh' });
    expect(parseHostOsProbe('AZITO_OS:%OS%:1\n').os).toBe('posix');
  });

  it('reads cmd.exe as a Windows host (CRLF line ends)', () => {
    expect(parseHostOsProbe('AZITO_OS:Windows_NT:$?\r\n')).toEqual({ os: 'windows', loginShell: 'cmd' });
  });

  it('reads PowerShell as a Windows host', () => {
    expect(parseHostOsProbe('AZITO_OS:%OS%:True\r\n')).toEqual({ os: 'windows', loginShell: 'powershell' });
    expect(parseHostOsProbe('AZITO_OS:%OS%:False\r\n').loginShell).toBe('powershell');
  });

  it('ignores a login banner or profile output around the marker line', () => {
    expect(parseHostOsProbe('Welcome to host\nLast login: today\nAZITO_OS:%OS%:0\nbye\n').os).toBe('posix');
    expect(parseHostOsProbe('Microsoft Windows\r\nAZITO_OS:Windows_NT:$?\r\n').os).toBe('windows');
  });

  it('is an error that shows what came back, the stderr and the exit code, when the answer is none of the three (never a guess)', () => {
    expect(() => parseHostOsProbe('')).toThrow(/got: nothing/);
    expect(() => parseHostOsProbe('command not found: echo')).toThrow(/command not found: echo/);
    expect(() => parseHostOsProbe('AZITO_OS:something else')).toThrow(/neither as sh, cmd\.exe nor PowerShell/);
    expect(() => parseHostOsProbe('', 'sh: 1: boom\n', 2)).toThrow(/got: nothing; stderr: sh: 1: boom; exit code 2/);
  });
});

function runPosix(shell: string, args: string[], env: Record<string, string> = {}): string {
  const out = spawnSync(shell, [...args, HOST_OS_PROBE_COMMAND], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });
  return out.stdout;
}

describe.skipIf(isWindows)('the OS probe on real POSIX shells', () => {
  const shells: Array<[string, string[]]> = [['sh', ['-c']], ['dash', ['-c']], ['bash', ['-c']]];

  it.each(shells)('%s answers as sh', (shell, args) => {
    expect(runPosix(shell, args)).toMatch(/^AZITO_OS:%OS%:\d+\n$/);
    expect(parseHostOsProbe(runPosix(shell, args)).loginShell).toBe('sh');
  });

  it.each(shells)('%s with `set -u` still answers (no variable is read)', (shell, args) => {
    const out = spawnSync(shell, [...args, `set -u; ${HOST_OS_PROBE_COMMAND}`], { encoding: 'utf8' });
    expect(parseHostOsProbe(out.stdout).loginShell).toBe('sh');
  });

  it.each(shells)('%s with the user\'s own `env` variable set answers the same', (shell, args) => {
    expect(runPosix(shell, args, { env: 'production' })).toMatch(/^AZITO_OS:%OS%:\d+\n$/);
  });

  it('answers when the previous command failed (a profile may end that way)', () => {
    const out = spawnSync('sh', ['-c', `false; ${HOST_OS_PROBE_COMMAND}`], { encoding: 'utf8' });
    expect(parseHostOsProbe(out.stdout).loginShell).toBe('sh');
  });
});

const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!isWindows)('the OS probe on a real Windows shell', () => {
  it('answers as cmd.exe', () => {
    const out = spawnSync(HOST_OS_PROBE_COMMAND, { shell: 'cmd.exe', encoding: 'utf8', timeout: 60_000 });
    expect(parseHostOsProbe(out.stdout)).toEqual({ os: 'windows', loginShell: 'cmd' });
  }, 60_000);

  it('answers as PowerShell 5.1', () => {
    const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', HOST_OS_PROBE_COMMAND], { encoding: 'utf8', timeout: 60_000 });
    expect(parseHostOsProbe(out.stdout)).toEqual({ os: 'windows', loginShell: 'powershell' });
  }, 60_000);

  it.skipIf(!hasPwsh)('answers as PowerShell 7 (pwsh)', () => {
    const out = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', HOST_OS_PROBE_COMMAND], { encoding: 'utf8', timeout: 60_000 });
    expect(parseHostOsProbe(out.stdout)).toEqual({ os: 'windows', loginShell: 'powershell' });
  }, 60_000);
});
