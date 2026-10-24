import { describe, expect, it } from 'vitest';
import { isBareShellCommand, programFileName } from './shellCommands';

describe('isBareShellCommand', () => {
  it.each(['bash', 'zsh', 'sh', 'fish', 'dash', 'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'])('%s is a shell', (name) => {
    expect(isBareShellCommand(name)).toBe(true);
  });

  it('ignores case (Windows names are case-insensitive)', () => {
    expect(isBareShellCommand('CMD.EXE')).toBe(true);
    expect(isBareShellCommand('PowerShell.exe')).toBe(true);
  });

  it.each(['claude', 'claude.exe', 'node', 'node.exe', 'vim', ''])('%s is not a shell', (name) => {
    expect(isBareShellCommand(name)).toBe(false);
  });
});

describe('programFileName', () => {
  it('takes the file name of a POSIX or a Windows path, whatever OS this runs on', () => {
    expect(programFileName('/usr/bin/bash')).toBe('bash');
    expect(programFileName('C:\\Windows\\System32\\cmd.exe')).toBe('cmd.exe');
    expect(programFileName('C:/Windows/System32/cmd.exe')).toBe('cmd.exe');
    expect(programFileName('bash')).toBe('bash');
  });
});
