import { spawnSync } from 'child_process';
import { describe, expect, it } from 'vitest';
import { buildWindowsPreflightCommand, checkWindowsPreflight, parseWindowsPreflight, type WindowsPreflightInfo } from './windowsPreflight';

const isWindows = process.platform === 'win32';

const BEGIN = '<<AZITO_PREFLIGHT_BEGIN>>';
const END = '<<AZITO_PREFLIGHT_END>>';

function output(over: Record<string, unknown> = {}, wrap = (json: string) => `${BEGIN}\n${json}\n${END}\n`): string {
  return wrap(JSON.stringify({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    nodeVersion: 'v24.14.0',
    arch: 'X64',
    windowsMajor: 10,
    windowsBuild: 26100,
    tailscaleIp: '100.64.0.9',
    home: 'C:\\Users\\dev',
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
  });
});

describe('parseWindowsPreflight', () => {
  it('reads node, architecture, Windows version, Tailscale IP and home', () => {
    expect(parseWindowsPreflight(output())).toEqual({
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      nodeVersion: '24.14.0',
      arch: 'x64',
      windowsVersion: 'Windows 11',
      tailscaleIp: '100.64.0.9',
      home: 'C:\\Users\\dev',
    });
  });

  it('tells Windows 10 from 11 by the build number', () => {
    expect(parseWindowsPreflight(output({ windowsBuild: 19045 })).windowsVersion).toBe('Windows 10');
    expect(parseWindowsPreflight(output({ windowsBuild: 22000 })).windowsVersion).toBe('Windows 11');
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
});

/**
 * The Windows job runs the real script on the real Windows PowerShell 5.1, under both login shells. The runner has Node but no
 * Tailscale, so it also checks the "no Tailscale" branch.
 */
describe.skipIf(!isWindows)('the preflight script on a real powershell.exe', () => {
  const line = buildWindowsPreflightCommand();

  it.each(['cmd.exe', 'powershell.exe'] as const)('prints JSON that is read, with %s as the login shell', (login) => {
    const out = login === 'cmd.exe'
      ? spawnSync(line, { shell: true, encoding: 'utf8', timeout: 120_000 })
      : spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', line], { encoding: 'utf8', timeout: 120_000 });
    expect(out.status, out.stderr).toBe(0);
    const info = parseWindowsPreflight(out.stdout);
    expect(info.nodeVersion).toBe(process.versions.node);
    expect(info.nodePath).toMatch(/node(\.exe)?$/i);
    expect(info.arch).toBe('x64');
    expect(info.windowsVersion).toMatch(/^Windows (10|11)$|^Windows NT/);
    expect(info.tailscaleIp).toBeNull();
    expect(info.home.length).toBeGreaterThan(0);
    expect(checkWindowsPreflight(info)).toEqual([expect.stringMatching(/^Tailscale IP not found/)]);
  }, 120_000);
});
