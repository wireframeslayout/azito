import { describe, expect, it, vi } from 'vitest';
import type { CommandResult, CommandSpec } from '../../../shared/exec/commandSpec';
import { buildHubLauncherScript, buildHubTaskXml, endHubProcesses, findHubProcesses, hubWindowsLayout, inspectRegisteredHub, resolveWindowsUserId, samePrefix } from '../windowsHubService';

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

  it('logs a run.ps1 that throws or exits with a code, instead of failing silently', () => {
    expect(script).toContain('& $run -Service -LogFile $logFile');
    expect(script).toContain('} catch {\n  Write-LauncherLog $_.Exception.Message\n  exit 1');
    expect(script).toContain('exited with code $code');
    expect(script.trimEnd().endsWith('exit $code')).toBe(true);
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

const scriptOf = (spec: CommandSpec): string => Buffer.from(spec.args[spec.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
const result = (exitCode: number, stdout = '', stderr = ''): CommandResult => ({ exitCode, signal: null, stdout, stderr });

describe('inspectRegisteredHub / samePrefix', () => {
  const generated = (prefix: string): string => buildHubTaskXml({ userId: 'PC\\me', systemRoot: 'C:\\Windows', layout: hubWindowsLayout(prefix) });

  it('reads the prefix back from the XML the Task Scheduler holds for a generated task', () => {
    expect(inspectRegisteredHub(generated(PREFIX), 'C:\\Windows')).toEqual({ prefix: PREFIX });
  });

  it.each(["C:\\Users\\O'Neil (Work)\\.azito", 'C:\\Users\\O\u2019Neil\\.azito', 'C:\\Users\\O\u2018Neil\u201A\u201B\\.azito'])('round-trips a prefix with quote characters: %s', (prefix) => {
    expect(inspectRegisteredHub(generated(prefix), 'C:\\Windows')).toEqual({ prefix });
  });

  it('is unknown (undefined) for a definition that is not ours', () => {
    expect(inspectRegisteredHub('<Task></Task>', 'C:\\Windows')).toBeUndefined();
  });

  it('is unknown when the action is not exactly what this code generates for that prefix, even if the $hubRoot line looks right', () => {
    const xml = generated(PREFIX);
    expect(inspectRegisteredHub(xml.replace('conhost.exe', 'cmd.exe'), 'C:\\Windows')).toBeUndefined();
    expect(inspectRegisteredHub(xml.replace('--headless', '--headless -Extra'), 'C:\\Windows')).toBeUndefined();
    expect(inspectRegisteredHub(xml, 'D:\\Windows')).toBeUndefined();
  });

  it('is unknown when the task has any other action than the one generated Exec', () => {
    const xml = generated(PREFIX);
    const extras = [
      '<Exec><Command>C:\\Windows\\System32\\cmd.exe</Command></Exec>',
      '<ComHandler><ClassId>{00000000-0000-0000-0000-000000000000}</ClassId></ComHandler>',
      '<SendEmail><Server>x</Server></SendEmail>',
      '<ShowMessage><Title>t</Title><Body>b</Body></ShowMessage>',
    ];
    for (const extra of extras) {
      expect(inspectRegisteredHub(xml.replace('</Actions>', `${extra}</Actions>`), 'C:\\Windows')).toBeUndefined();
      expect(inspectRegisteredHub(xml.replace(/<Actions\b[^>]*>/, (m) => `${m}${extra}`), 'C:\\Windows')).toBeUndefined();
    }
  });

  it('is unknown with a second Actions element or stray text in Actions, and still known with comments around', () => {
    const xml = generated(PREFIX);
    expect(inspectRegisteredHub(xml.replace('</Actions>', 'text</Actions>'), 'C:\\Windows')).toBeUndefined();
    expect(inspectRegisteredHub(xml.replace('</Actions>', '</Actions><Actions Context="Author"><Exec><Command>x</Command></Exec></Actions>'), 'C:\\Windows')).toBeUndefined();
    expect(inspectRegisteredHub(xml.replace('</Actions>', '<!-- note --></Actions>'), 'C:\\Windows')).toEqual({ prefix: PREFIX });
  });

  it('ignores case and a trailing separator, and nothing else', () => {
    expect(samePrefix('C:\\Users\\Me\\.azito\\', 'c:\\users\\me\\.AZITO')).toBe(true);
    expect(samePrefix('C:\\Users\\Me\\.azito', 'C:\\Users\\Me\\.azito2')).toBe(false);
  });
});

describe('findHubProcesses', () => {
  it('lists node.exe of this user with an azito-hub.cjs of any version under the hub folder, as the given and the real path, never itself', async () => {
    const run = vi.fn(async (_spec: CommandSpec) => result(0, '4321 133000000000000000\r\nnoise\r\n77 5\r\n'));
    const found = await findHubProcesses(run, 'C:\\Windows', [`${PREFIX}\\hub`, 'D:\\real\\.azito\\hub'], 999);
    expect(found).toEqual([{ pid: 4321, created: '133000000000000000' }, { pid: 77, created: '5' }]);
    const script = scriptOf(run.mock.calls[0][0]);
    expect(script).toContain("[regex]::Escape('C:\\Users\\Foo Bar (Work)\\.azito\\hub\\') + '|' + [regex]::Escape('D:\\real\\.azito\\hub\\')");
    expect(script).toContain('if ($p.Id -eq 999) { continue }');
    // Opened first (the handle pins the id), then the command line / owner / creation date of that id are read and cross-checked.
    expect(script.indexOf('$null = $p.Handle')).toBeLessThan(script.indexOf('Get-CimInstance Win32_Process -Filter "ProcessId = $($p.Id)"'));
    expect(script).toContain('Get-Process -Name node');
    expect(script).toContain('$cim.CreationDate.ToFileTimeUtc() - $started.ToFileTimeUtc()');
    // Gone and another user's are skipped; this user's own process that cannot be verified is an error with its id.
    expect(script).toContain('if ($mine -eq $false) { continue }');
    expect(script).toContain('throw "Cannot open hub process $($p.Id) to verify it: $openError"');
    expect(script).toContain('throw "Cannot tell whose hub process $($p.Id) is');
  });

  it('fails with the script\'s own message', async () => {
    await expect(findHubProcesses(async () => result(1, '', 'boom'), 'C:\\Windows', [`${PREFIX}\\hub`], 1)).rejects.toThrow(/Looking for the hub processes failed.*boom/);
  });
});

describe('endHubProcesses', () => {
  it('does nothing, and starts no PowerShell, when nothing was running', async () => {
    const run = vi.fn(async () => result(0));
    expect(await endHubProcesses(run, 'C:\\Windows', [], 1000)).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it('waits for the grace period before it ends anything, and ends only the same process through the handle it holds', async () => {
    const run = vi.fn(async (_spec: CommandSpec) => result(0, 'forced 4321\r\n'));
    const forced = await endHubProcesses(run, 'C:\\Windows', [{ pid: 4321, created: '133000000000000000' }], 20_000);
    expect(forced).toEqual([4321]);
    const script = scriptOf(run.mock.calls[0][0]);
    expect(script).toContain('Id = 4321; Created = 133000000000000000');
    expect(script).toContain('AddMilliseconds(20000)');
    expect(script.indexOf('AddMilliseconds(20000)')).toBeLessThan(script.indexOf('.Kill()'));
    // The Process object holds a handle ($p.Handle), the start time is read from it, and it is the one that is killed.
    expect(script).toContain('$null = $p.Handle');
    expect(script).toContain('$started -ne $target.Created');
    // Gone or another process: left alone. Exists but cannot be opened to be checked: an error with the id, never "gone".
    expect(script).toContain('throw "Cannot open hub process $($target.Id) to verify it: $reason"');
    expect(script).toContain('$p.Kill()');
    expect(script).not.toContain('Stop-Process');
    // A single process comes back unwrapped, and a PowerShell 5.1 object has no .Count: every count goes through @().
    expect(script).not.toMatch(/(?<!@)\(Get-Alive\)\.Count/);
    expect(script).toContain('@(Get-Alive).Count');
  });

  it('fails when a process would not end', async () => {
    const run = vi.fn(async () => result(1, '', 'A hub process did not end: 9'));
    await expect(endHubProcesses(run, 'C:\\Windows', [{ pid: 9, created: '1' }], 10)).rejects.toThrow(/did not end: 9/);
  });
});
