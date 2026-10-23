import { describe, expect, it, vi } from 'vitest';
import type { CommandResult, CommandSpec } from '../../../shared/exec/commandSpec';
import { buildHubLauncherScript, buildHubTaskXml, endHubProcesses, hubWindowsLayout, resolveWindowsUserId } from '../windowsHubService';

const PREFIX = 'C:\\Users\\Foo Bar (Work)\\.azito';

/** The script a task of this definition runs, back from its -EncodedCommand argument. */
function launcherOf(xml: string): string {
  const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(xml)?.[1];
  if (!encoded) throw new Error('the task has no -EncodedCommand');
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

describe('hubWindowsLayout', () => {
  it('puts the pointer under hub\\ and the log under logs\\, beside hub\\', () => {
    expect(hubWindowsLayout(`${PREFIX}\\`)).toEqual({
      prefix: PREFIX,
      hubRoot: `${PREFIX}\\hub`,
      pointer: `${PREFIX}\\hub\\current.txt`,
      logsDir: `${PREFIX}\\logs`,
      logFile: `${PREFIX}\\logs\\hub.log`,
    });
  });

  it('refuses a prefix that is not an absolute Windows path', () => {
    expect(() => hubWindowsLayout('.azito')).toThrow(/absolute/);
    expect(() => hubWindowsLayout('/home/u/.azito')).toThrow(/absolute/);
  });
});

describe('buildHubTaskXml', () => {
  const xml = buildHubTaskXml({ userId: 'PC\\me', systemRoot: 'C:\\Windows', layout: hubWindowsLayout(PREFIX) });

  it('runs the launcher under conhost.exe --headless, so no console window appears and the version is read at start', () => {
    expect(xml).toContain('<Command>C:\\Windows\\System32\\conhost.exe</Command>');
    expect(xml).toMatch(/<Arguments>--headless C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe -NoProfile /);
    expect(xml).toContain(`<WorkingDirectory>${PREFIX}\\hub</WorkingDirectory>`);
  });

  it('is a logon task of that user, restarted when it fails', () => {
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<UserId>PC\\me</UserId>');
    expect(xml).toContain('<RestartOnFailure>');
  });

  it('has no version in it: an update only switches current.txt', () => {
    expect(xml).not.toMatch(/v\d+\.\d+\.\d+/);
    expect(launcherOf(xml)).toContain(`${PREFIX}\\hub\\current.txt`);
  });
});

describe('buildHubLauncherScript', () => {
  const script = buildHubLauncherScript(hubWindowsLayout(PREFIX));

  it('validates the pointer, starts run.ps1 in service mode with the log path, and logs a bad pointer', () => {
    expect(script).toContain("$pointer = 'C:\\Users\\Foo Bar (Work)\\.azito\\hub\\current.txt'");
    expect(script).toContain("-notmatch '^v?[0-9]+\\.[0-9]+\\.[0-9]+([-+.][0-9A-Za-z.-]+)?$'");
    expect(script).toContain('& $run -Service -LogFile $logFile');
    expect(script).toContain('AppendAllText($logFile');
  });

  it('quotes a prefix that contains an apostrophe', () => {
    const quoted = buildHubLauncherScript(hubWindowsLayout("C:\\Users\\O'Neil\\.azito"));
    expect(quoted).toContain("$pointer = 'C:\\Users\\O''Neil\\.azito\\hub\\current.txt'");
  });
});

describe('resolveWindowsUserId', () => {
  it('is DOMAIN\\user', () => {
    expect(resolveWindowsUserId({ USERDOMAIN: 'PC', USERNAME: 'me' })).toBe('PC\\me');
  });

  it('is an error when the user cannot be told, not a guess', () => {
    expect(() => resolveWindowsUserId({ USERNAME: 'me' })).toThrow(/USERDOMAIN/);
    expect(() => resolveWindowsUserId({ USERDOMAIN: 'PC' })).toThrow(/USERNAME/);
  });
});

describe('endHubProcesses', () => {
  const result = (exitCode: number, stderr = ''): CommandResult => ({ exitCode, signal: null, stdout: '', stderr });

  it('runs one PowerShell sweep for node.exe with the entry file as the exact argument, never ending itself', async () => {
    const run = vi.fn(async (_spec: CommandSpec) => result(0));
    await endHubProcesses(run, 'C:\\Windows', `${PREFIX}\\hub\\v0.12.0\\azito-hub.cjs`, 4321);
    const spec = run.mock.calls[0][0];
    expect(spec.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    const script = Buffer.from(spec.args[spec.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
    expect(script).toContain("Name = 'node.exe'");
    expect(script).toContain("$envArgument = 'C:\\Users\\Foo Bar (Work)\\.azito\\hub\\v0.12.0\\azito-hub.cjs'");
    expect(script).toContain('$_.ProcessId -ne 4321');
    expect(script).not.toContain("'conhost.exe'");
  });

  it('fails with the script\'s own message when a process would not end', async () => {
    const run = vi.fn(async () => result(1, 'An hub process did not end: 9'));
    await expect(endHubProcesses(run, 'C:\\Windows', 'C:\\x\\azito-hub.cjs', 1)).rejects.toThrow(/did not end: 9/);
  });
});
