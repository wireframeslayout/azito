import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { HOST_OS_PROBE_COMMAND, parseHostOsProbe } from './hostOsProbe';

const isWindows = process.platform === 'win32';

describe('parseHostOsProbe (the output of the OS probe, one fixed example per login shell)', () => {
  it('reads sh as a POSIX host', () => {
    expect(parseHostOsProbe('AZITO_OS:%OS%::OS\n')).toEqual({ os: 'posix', loginShell: 'sh' });
  });

  it('reads cmd.exe as a Windows host (CRLF line ends)', () => {
    expect(parseHostOsProbe('AZITO_OS:Windows_NT:$env:OS\r\n')).toEqual({ os: 'windows', loginShell: 'cmd' });
  });

  it('reads PowerShell as a Windows host', () => {
    expect(parseHostOsProbe('AZITO_OS:%OS%:Windows_NT\r\n')).toEqual({ os: 'windows', loginShell: 'powershell' });
  });

  it('ignores a login banner or profile output around the marker line', () => {
    expect(parseHostOsProbe('Welcome to host\nLast login: today\nAZITO_OS:%OS%::OS\nbye\n').os).toBe('posix');
    expect(parseHostOsProbe('Microsoft Windows\r\nAZITO_OS:Windows_NT:$env:OS\r\n').os).toBe('windows');
  });

  it('is an error that shows what came back when the answer is none of the three (never a guess)', () => {
    expect(() => parseHostOsProbe('')).toThrow(/got: nothing/);
    expect(() => parseHostOsProbe('command not found: echo')).toThrow(/command not found: echo/);
    expect(() => parseHostOsProbe('AZITO_OS:something else')).toThrow(/neither as sh, cmd\.exe nor PowerShell/);
  });
});

describe.skipIf(isWindows)('the OS probe on a real sh', () => {
  it('answers as sh', () => {
    const out = spawnSync('sh', ['-c', HOST_OS_PROBE_COMMAND], { encoding: 'utf8' });
    expect(out.stdout).toBe('AZITO_OS:%OS%::OS\n');
    expect(parseHostOsProbe(out.stdout).loginShell).toBe('sh');
  });
});

describe.skipIf(!isWindows)('the OS probe on a real Windows shell', () => {
  it('answers as cmd.exe', () => {
    const out = spawnSync(HOST_OS_PROBE_COMMAND, { shell: 'cmd.exe', encoding: 'utf8', timeout: 60_000 });
    expect(parseHostOsProbe(out.stdout)).toEqual({ os: 'windows', loginShell: 'cmd' });
  }, 60_000);

  it('answers as PowerShell', () => {
    const out = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', HOST_OS_PROBE_COMMAND], { encoding: 'utf8', timeout: 60_000 });
    expect(parseHostOsProbe(out.stdout)).toEqual({ os: 'windows', loginShell: 'powershell' });
  }, 60_000);
});
