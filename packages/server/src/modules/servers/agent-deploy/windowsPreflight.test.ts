import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { buildWindowsPreflightCommand, checkWindowsPreflight, WMI_DENIED_MESSAGE, parseWindowsPreflight, type WindowsPreflightInfo } from './windowsPreflight';

const isWindows = process.platform === 'win32';

const BEGIN = '<<AZITO_PREFLIGHT_BEGIN>>';
const END = '<<AZITO_PREFLIGHT_END>>';

function output(over: Record<string, unknown> = {}, wrap = (json: string) => `${BEGIN}\n${json}\n${END}\n`): string {
  return wrap(JSON.stringify({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    nodeVersion: 'v24.14.0',
    arch: 'AMD64',
    windowsCaption: 'Microsoft Windows 11 Pro',
    buildNumber: '22631',
    cim: 'ok',
    tailscaleIp: '100.64.0.9',
    home: 'C:\\Users\\dev',
    systemRoot: 'C:\\Windows',
    userId: 'DESKTOP-1\\dev',
    ...over,
  }));
}

describe('buildWindowsPreflightCommand', () => {
  it('is the dialect\'s fixed powershell.exe EncodedCommand line whose script prints JSON between markers', () => {
    const line = buildWindowsPreflightCommand();
    const match = /^powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(line);
    expect(match).not.toBeNull();
    const script = Buffer.from(match![1], 'base64').toString('utf16le');
    expect(script).toContain(BEGIN);
    expect(script).toContain(END);
    expect(script).toContain('ConvertTo-Json');
    expect(script).toContain('Tailscale\\tailscale.exe');
    expect(script).toContain("$cim = 'denied'");
  });
});

describe('checkWindowsPreflight: the Windows build', () => {
  const info = (buildNumber: number | null): WindowsPreflightInfo => ({ nodePath: 'C:\\node.exe', nodeVersion: '24.14.0', arch: 'x64', windowsVersion: 'Windows 10', buildNumber, tailscaleIp: '100.64.0.9', home: 'C:\\Users\\d', systemRoot: 'C:\\Windows', userId: 'PC\\d', cim: buildNumber === null ? 'unreadable' : 'ok' });
  it('accepts 1809 (build 17763) and later', () => {
    expect(checkWindowsPreflight(info(17763))).toEqual([]);
    expect(checkWindowsPreflight(info(26100))).toEqual([]);
  });
  it('refuses an older build and an unreadable one, with the reason', () => {
    expect(checkWindowsPreflight(info(17134))).toEqual([expect.stringMatching(/1809.*found: build 17134.*conhost\.exe --headless/)]);
    expect(checkWindowsPreflight(info(null))).toEqual([expect.stringMatching(/Could not read the Windows build number/)]);
  });
});

describe('checkWindowsPreflight: WMI refused or unreadable', () => {
  const base = (): WindowsPreflightInfo => parseWindowsPreflight(output());
  it('reads the WMI result as its own value, apart from the build number', () => {
    expect(parseWindowsPreflight(output({ cim: 'denied', buildNumber: null, windowsCaption: null }))).toMatchObject({ cim: 'denied', buildNumber: null });
    expect(parseWindowsPreflight(output({ cim: 'unreadable', buildNumber: null }))).toMatchObject({ cim: 'unreadable', buildNumber: null });
    expect(parseWindowsPreflight(output()).cim).toBe('ok');
    expect(() => parseWindowsPreflight(output({ cim: undefined }))).toThrow(/unexpected result/);
  });
  it('stops with the WMI reason and the issue, and does not call it an old or unreadable build', () => {
    const missing = checkWindowsPreflight({ ...base(), cim: 'denied', buildNumber: null, windowsVersion: null });
    expect(missing).toEqual([WMI_DENIED_MESSAGE]);
    expect(missing[0]).toMatch(/administrator account.*v0\.13\.0.*issues\/559/);
  });
  it('keeps the other problems beside the WMI reason', () => {
    expect(checkWindowsPreflight({ ...base(), cim: 'denied', buildNumber: null, tailscaleIp: null })).toHaveLength(2);
  });
  it('reports a WMI failure for another reason as an unreadable build, not as a refusal', () => {
    const missing = checkWindowsPreflight({ ...base(), cim: 'unreadable', buildNumber: null });
    expect(missing).toEqual([expect.stringMatching(/Could not read the Windows build number/)]);
  });
});

describe('parseWindowsPreflight', () => {
  it('reads node, architecture, Windows version, Tailscale IP and home', () => {
    expect(parseWindowsPreflight(output())).toEqual({
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      nodeVersion: '24.14.0',
      arch: 'x64',
      windowsVersion: 'Windows 11 Pro',
      buildNumber: 22631,
      cim: 'ok',
      tailscaleIp: '100.64.0.9',
      home: 'C:\\Users\\dev',
      systemRoot: 'C:\\Windows',
      userId: 'DESKTOP-1\\dev',
    });
  });

  it('shows the OS name Windows gives, Server included (display only)', () => {
    expect(parseWindowsPreflight(output({ windowsCaption: 'Microsoft Windows Server 2022 Datacenter' })).windowsVersion).toBe('Windows Server 2022 Datacenter');
    expect(parseWindowsPreflight(output({ windowsCaption: null })).windowsVersion).toBeNull();
  });

  it('maps the registry\'s architecture words, and keeps an unknown one as it is', () => {
    expect(parseWindowsPreflight(output({ arch: 'ARM64' })).arch).toBe('arm64');
    expect(parseWindowsPreflight(output({ arch: 'x86' })).arch).toBe('x86');
    expect(parseWindowsPreflight(output({ arch: 'IA64' })).arch).toBe('IA64');
    expect(parseWindowsPreflight(output({ arch: null })).arch).toBeNull();
  });

  it('reads \\uXXXX-escaped non-ASCII text (the script prints ASCII only)', () => {
    const noisy = output({}, () => `${BEGIN}\n{"nodePath":null,"nodeVersion":null,"arch":"AMD64","windowsCaption":null,"buildNumber":null,"cim":"ok","tailscaleIp":null,"home":"C:\\\\Users\\u30c6\\u30b9\\u30c8","systemRoot":"C:\\\\Windows","userId":"PC\\\\\\u30c6"}\n${END}\n`);
    expect(parseWindowsPreflight(noisy).home).toBe('C:\\Users\u30c6\u30b9\u30c8');
  });

  it('is not broken by a banner or profile output before and after the markers (CRLF too)', () => {
    const noisy = output({}, (json) => `Welcome!\r\nProfile loaded\r\n${BEGIN}\r\n${json}\r\n${END}\r\ntrailing\r\n`);
    expect(parseWindowsPreflight(noisy).nodeVersion).toBe('24.14.0');
  });

  it('reads a host without node or Tailscale as null, not as an error', () => {
    const info = parseWindowsPreflight(output({ nodePath: null, nodeVersion: null, tailscaleIp: null }));
    expect(info.nodeVersion).toBeNull();
    expect(info.tailscaleIp).toBeNull();
  });

  it('is an error when the markers are missing, the JSON is broken or a field is missing', () => {
    expect(() => parseWindowsPreflight('')).toThrow(/no result between the markers/);
    expect(() => parseWindowsPreflight('', 'Get-CimInstance : boom\n', 1)).toThrow(/got: nothing; stderr: Get-CimInstance : boom; exit code 1/);
    expect(() => parseWindowsPreflight('', '$env:AZITO_TOKEN = "s3cret-value"', 1)).toThrow(/AZITO_TOKEN = \[REDACTED\]/);
    expect(() => parseWindowsPreflight('set API_KEY=s3cret-value', '', 0)).toThrow(/API_KEY=\[REDACTED\]/);
    expect(() => parseWindowsPreflight(`${BEGIN}\n{broken\n${END}`)).toThrow(/not JSON/);
    expect(() => parseWindowsPreflight(`${BEGIN}\n{"arch":"X64"}\n${END}`)).toThrow(/unexpected result/);
    expect(() => parseWindowsPreflight(`${END}\n${BEGIN}`)).toThrow(/no result between the markers/);
  });
});

describe('checkWindowsPreflight', () => {
  const ok = (over: Partial<WindowsPreflightInfo> = {}): WindowsPreflightInfo => ({ ...parseWindowsPreflight(output()), ...over });

  it('accepts Node v24 on x64 with a Tailscale IP', () => {
    expect(checkWindowsPreflight(ok())).toEqual([]);
  });

  it('refuses an old Node, and a missing one', () => {
    expect(checkWindowsPreflight(ok({ nodeVersion: '22.1.0' }))).toEqual(['Node.js v24+ required (found: v22.1.0)']);
    expect(checkWindowsPreflight(ok({ nodePath: null, nodeVersion: null }))).toEqual(['Node.js v24+ required (found: not installed)']);
  });

  it('refuses arm64 with the reason', () => {
    expect(checkWindowsPreflight(ok({ arch: 'arm64' }))[0]).toMatch(/x86_64 architecture required \(found: arm64; Windows on ARM is not supported\)/);
  });

  it('refuses a host without a Tailscale IP', () => {
    expect(checkWindowsPreflight(ok({ tailscaleIp: null }))[0]).toMatch(/Tailscale IP not found \(got: empty/);
  });

  it('lists every problem at once', () => {
    expect(checkWindowsPreflight(ok({ nodeVersion: null, arch: 'arm64', tailscaleIp: null }))).toHaveLength(3);
  });

  it('refuses an unreadable architecture instead of assuming x64', () => {
    expect(checkWindowsPreflight(ok({ arch: null }))).toEqual([expect.stringMatching(/^Could not read the OS architecture/)]);
  });
});

/**
 * The Windows job runs the real script on the real Windows PowerShell 5.1 under both login shells, and on PowerShell 7 (pwsh)
 * when the runner has it. The runner has Node but no Tailscale, so it also checks the "no Tailscale" branch.
 */
const hasPwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0;

type Login = 'cmd.exe' | 'powershell.exe' | 'pwsh';
const LOGINS: Login[] = hasPwsh ? ['cmd.exe', 'powershell.exe', 'pwsh'] : ['cmd.exe', 'powershell.exe'];

function run(line: string, login: Login, env: NodeJS.ProcessEnv = process.env) {
  return login === 'cmd.exe'
    ? spawnSync(line, { shell: true, encoding: 'utf8', timeout: 120_000, env })
    : spawnSync(login, ['-NoProfile', '-NonInteractive', '-Command', line], { encoding: 'utf8', timeout: 120_000, env });
}

describe.skipIf(!isWindows)('the preflight script on a real PowerShell', () => {
  const line = buildWindowsPreflightCommand();

  it.each(LOGINS)('prints JSON that is read, with %s as the login shell', (login) => {
    const out = run(line, login);
    expect(out.status, out.stderr).toBe(0);
    const info = parseWindowsPreflight(out.stdout);
    expect(info.nodeVersion).toBe(process.versions.node);
    expect(info.nodePath).toMatch(/node(\.exe)?$/i);
    expect(info.arch).toBe('x64');
    expect(info.windowsVersion).toMatch(/^Windows /);
    expect(info.buildNumber).toBeGreaterThanOrEqual(17763);
    // The runner is an administrator, so WMI answers; a refusal cannot be reproduced there (the denied branch is covered by the parse tests).
    expect(info.cim).toBe('ok');
    expect(info.tailscaleIp).toBeNull();
    expect(info.home.length).toBeGreaterThan(0);
    expect(info.systemRoot.toLowerCase()).toBe((process.env.SystemRoot ?? '').toLowerCase());
    expect(info.userId).toMatch(/^[^\\]+\\[^\\]+$/);
    expect(checkWindowsPreflight(info)).toEqual([expect.stringMatching(/^Tailscale IP not found/)]);
  }, 120_000);

  it.each(LOGINS)('prints ASCII only and reads a non-ASCII home back unchanged, with %s as the login shell', (login) => {
    const home = 'C:\\Users\u30c6\u30b9\u30c8 caf\u00e9';
    const out = run(line, login, { ...process.env, USERPROFILE: home });
    expect(out.status, out.stderr).toBe(0);
    // eslint-disable-next-line no-control-regex
    expect(out.stdout).toMatch(/^[\x00-\x7F]*$/);
    expect(parseWindowsPreflight(out.stdout).home).toBe(home);
  }, 120_000);
});
