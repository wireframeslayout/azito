import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { assertRealDirectoryChain, isDirectDirectoryOnDevice, readInstallInventory } from '../windowsInstallInventory';
import { spawnSync } from 'child_process';

const roots: string[] = [];
function temp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-inventory-'));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('readInstallInventory', () => {
  it('compares resolved parent paths and devices instead of short or long leaf spellings', () => {
    const realParent = 'C:\\Users';
    expect(isDirectDirectoryOnDevice(1, 1, 'c:\\users\\runneradmin', realParent, true)).toBe(true);
    expect(isDirectDirectoryOnDevice(2, 1, 'C:\\Users\\runneradmin', realParent, true)).toBe(false);
    expect(isDirectDirectoryOnDevice(1, 1, 'C:\\Elsewhere\\runneradmin', realParent, true)).toBe(false);
  });

  it('accepts a short ancestor when realpath expands its spelling', () => {
    const root = temp();
    const short = path.join(root, 'RUNNER~1');
    fs.mkdirSync(path.join(short, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(short, 'nested', 'file'), 'content');
    const realpath = fs.realpathSync.native;
    const spy = vi.spyOn(fs.realpathSync, 'native').mockImplementation((name, options) => {
      const resolved = realpath(name, options as never);
      return typeof resolved === 'string' ? resolved.replace('RUNNER~1', 'runneradmin') : resolved;
    });
    try {
      assertRealDirectoryChain(path.join(short, 'nested'));
      expect(readInstallInventory(root).directories).toEqual(['RUNNER~1', path.join('RUNNER~1', 'nested')]);
    } finally { spy.mockRestore(); }
  });

  it.skipIf(process.platform !== 'win32')('accepts a real 8.3 ancestor for chain and inventory', () => {
    const root = temp();
    const parent = path.join(root, 'A long directory name for short path');
    fs.mkdirSync(path.join(parent, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(parent, 'nested', 'file'), 'content');
    const script = `$sig = '[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetShortPathName(string path, System.Text.StringBuilder result, uint size);'; Add-Type -MemberDefinition $sig -Name ShortPaths -Namespace AzitoTest; $b = New-Object System.Text.StringBuilder 32768; if ([AzitoTest.ShortPaths]::GetShortPathName($env:AZITO_SHORT_TEST, $b, $b.Capacity) -eq 0) { throw 'GetShortPathName failed' }; $b.ToString()`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const powershell = path.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = spawnSync(powershell, ['-NoProfile', '-EncodedCommand', encoded], { encoding: 'utf8', env: { ...process.env, AZITO_SHORT_TEST: parent } });
    expect(result.status, result.stderr).toBe(0);
    const shortPath = result.stdout.trim();
    if (!/~[0-9]+/i.test(shortPath)) console.warn('[windowsInstallInventory] 8.3 names are unavailable on this volume');
    assertRealDirectoryChain(path.join(shortPath, 'nested'));
    expect(readInstallInventory(shortPath).directories).toEqual(['nested']);
  });

  it('records files, content and empty directories deterministically', () => {
    const root = temp();
    fs.mkdirSync(path.join(root, 'empty'));
    fs.writeFileSync(path.join(root, 'file'), 'content');
    expect(readInstallInventory(root)).toEqual({
      directories: ['empty'],
      files: [{ path: 'file', sha256: crypto.createHash('sha256').update('content').digest('hex') }],
    });
  });

  it('refuses to enter a symlink', () => {
    const root = temp();
    fs.symlinkSync(temp(), path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => readInstallInventory(root)).toThrow(/link/);
  });

  it('refuses a symlink in the path to the root', () => {
    const root = temp();
    const real = temp();
    fs.mkdirSync(path.join(real, 'nested'));
    const link = path.join(root, 'link');
    fs.symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => readInstallInventory(path.join(link, 'nested'))).toThrow(/link/);
  });
});
