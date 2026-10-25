import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { powershellEncodedArgs } from '../../shared/os/shellDialect';
import { formatHubPointer, parseHubPointer, writeHubPointer } from './hubPointer';
import { HUB_POINTER_VERSION_PATTERN } from './hubVersion';

/**
 * The pointer as the programs that read it on Windows see it: azito.cmd's own `findstr` line (taken out of install.ps1, not copied
 * here) and the launcher's read-and-match (`ReadAllText`, trim, `-match` with the shared pattern), both run for real.
 */
const SYSTEM_ROOT = process.env.SystemRoot ?? 'C:\\Windows';
const POWERSHELL = path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const INSTALL_PS1 = path.resolve(__dirname, '..', '..', '..', '..', '..', 'install.ps1');

let dir: string;
let file: string;

/** azito.cmd's check: findstr selects the lines that are NOT a version, so the pointer is accepted when it finds none (errorlevel 1). */
function azitoCmdAccepts(pointer: string): boolean {
  const install = fs.readFileSync(INSTALL_PS1, 'utf8');
  const line = /^findstr \/r \/x \/v \/c:.*"%AZITO_ROOT%\\hub\\current\.txt" >nul$/m.exec(install)?.[0];
  if (!line) throw new Error('azito.cmd\'s findstr line was not found in install.ps1');
  const batch = path.join(dir, 'check.cmd');
  fs.writeFileSync(batch, ['@echo off', `set "AZITO_ROOT=${dir}"`, `set "CHECK=${pointer}"`, line.replace('%AZITO_ROOT%\\hub\\current.txt', '%CHECK%'), 'if errorlevel 1 (exit /b 0) else (exit /b 1)'].join('\r\n'));
  return spawnSync(path.join(SYSTEM_ROOT, 'System32', 'cmd.exe'), ['/d', '/c', batch], { windowsHide: true }).status === 0;
}

/** The launcher's read: `ReadAllText($pointer)`, trim a BOM and spaces, then the shared pattern. */
function launcherAccepts(pointer: string): boolean {
  const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
  const script = [
    `$v = ([IO.File]::ReadAllText(${q(pointer)})).TrimStart([char]0xFEFF).Trim()`,
    `if ($v -match ${q(HUB_POINTER_VERSION_PATTERN)}) { exit 0 } else { exit 1 }`,
  ].join('\n');
  return spawnSync(POWERSHELL, powershellEncodedArgs(script), { windowsHide: true }).status === 0;
}

describe.skipIf(process.platform !== 'win32')('current.txt on Windows', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito pointer (win) '));
    file = path.join(dir, 'current.txt');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('is accepted by azito.cmd and the launcher when this code writes it, first and when replacing', () => {
    for (const version of ['v0.12.0', 'v0.12.1-rc.1', 'v0.0.0-ci-a']) {
      writeHubPointer(file, version);
      expect(azitoCmdAccepts(file), `azito.cmd: ${version}`).toBe(true);
      expect(launcherAccepts(file), `launcher: ${version}`).toBe(true);
      expect(parseHubPointer(fs.readFileSync(file))).toBe(version);
    }
  });

  it('refuses what azito.cmd refuses (a BOM, spaces, a name that is not a version)', () => {
    fs.writeFileSync(file, '\uFEFFv0.12.0\r\n', 'utf8');
    expect(azitoCmdAccepts(file)).toBe(false);
    expect(() => parseHubPointer(fs.readFileSync(file))).toThrow(/BOM/);
    fs.writeFileSync(file, 'v0.12.0 \r\n');
    expect(azitoCmdAccepts(file)).toBe(false);
    expect(() => parseHubPointer(fs.readFileSync(file))).toThrow();
    fs.writeFileSync(file, 'latest\r\n');
    expect(azitoCmdAccepts(file)).toBe(false);
    expect(() => parseHubPointer(fs.readFileSync(file))).toThrow();
  });

  it('replaces a pointer written by install.ps1 (Write-TextAtomic: UTF-8, no BOM, tag and CRLF) in place', () => {
    const ps = spawnSync(POWERSHELL, powershellEncodedArgs([
      `$Path = '${file.replace(/'/g, "''")}'`,
      '[System.IO.File]::WriteAllText($Path, "v0.12.0`r`n", (New-Object System.Text.UTF8Encoding($false)))',
    ].join('\n')), { windowsHide: true });
    expect(ps.status).toBe(0);
    expect(fs.readFileSync(file)).toEqual(Buffer.from(formatHubPointer('v0.12.0'), 'ascii'));
    writeHubPointer(file, 'v0.12.1');
    expect(fs.readFileSync(file)).toEqual(Buffer.from('v0.12.1\r\n', 'ascii'));
  });

  it('can be replaced again and again, each time leaving a complete pointer', () => {
    writeHubPointer(file, 'v0.12.0');
    for (let i = 0; i < 50; i++) {
      writeHubPointer(file, i % 2 === 0 ? 'v0.12.1' : 'v0.12.0');
      expect(fs.readFileSync(file, 'utf8')).toMatch(/^v0\.12\.[01]\r\n$/);
    }
  });
});
