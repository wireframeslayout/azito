import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WINDOWS_PROCESS_RECORDS } from './windowsProcessInfo';
import { buildEndProcessesScript, buildProcessPresentScript } from './windowsProcessSweep';

// Only the generated test script is changed: production scripts have no switch for these failures.
function runInspection(kind: 'sweep' | 'present' | 'records', state: 'exited' | 'alive' | 'unknown' | 'changed' | 'owner_unknown' | 'start_unknown'): string {
  let body = kind === 'sweep'
    ? buildEndProcessesScript({ image: 'powershell.exe', argument: 'never-matches', label: 'test', endParentConhost: false })
    : kind === 'present' ? buildProcessPresentScript('powershell.exe', 'never-matches', ['never-matches']) : WINDOWS_PROCESS_RECORDS.join('\n') + '\n@(Read-Process $target).Count';
  function replaceChecked(search: string | RegExp, replacement: string): void {
    const replaced = body.replace(search, replacement);
    expect(replaced).not.toBe(body);
    body = replaced;
  }
  replaceChecked('text.buffer == IntPtr.Zero ? null : Marshal.PtrToStringUni(text.buffer, text.length / 2)', 'null');
  if (state === 'owner_unknown') replaceChecked(/\[AzitoProcessList\]::Owner\([^)]*\)/g, '$null');
  if (state === 'unknown') replaceChecked('uint code;\nbool? exited = GetExitCodeProcess(h, out code) ? (bool?)(code != 259) : null;', 'bool? exited = null;');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'azito-process-test-'));
  const pidFile = path.join(dir, 'child.pid');
  const script = `
$ErrorActionPreference = 'Stop'
$child = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile -NonInteractive -Command Start-Sleep -Seconds 120' -PassThru
try {
  [IO.File]::WriteAllText('${pidFile.replace(/'/g, "''")}', [string]$child.Id)
  $handle = $child.Handle
  $started = $child.StartTime
  $childPath = $child.Path
  if ('${state}' -in @('exited', 'changed', 'owner_unknown', 'start_unknown')) { Stop-Process -Id $child.Id -Force; $child.WaitForExit() }
  $target = [pscustomobject]@{ Id = $child.Id; StartTime = $started; ProcessName = 'powershell'; Path = $childPath }
  if ('${state}' -eq 'start_unknown') { $target.StartTime = $null }
  $script:calls = 0
  function Get-Process { param($Name, $Id, $ErrorAction)
    if ($Id) {
      $script:calls++
      if ('${state}' -eq 'changed') { return [pscustomobject]@{ Id = $target.Id; StartTime = $target.StartTime.AddSeconds(1) } }
    }
    return $target
  }
  $me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  ${body}
} finally { if (-not $child.HasExited) { Stop-Process -Id $child.Id -Force }; $child.WaitForExit(); $child.Dispose(); [IO.File]::Delete('${pidFile.replace(/'/g, "''")}') }
`;
  try {
    const file = path.join(dir, 'test.ps1');
    writeFileSync(file, script);
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', file], { encoding: 'utf8', timeout: 30000 });
    if (result.error) throw result.error;
    return result.status === 0 ? result.stdout.trim() : `ERROR: ${result.stderr}`;
  } finally {
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid); } catch { /* Already exited. */ } }
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== 'win32')('process inspections with real Windows processes', () => {
  for (const kind of ['sweep', 'present', 'records'] as const) {
    it(`${kind} excludes an exited process with an open handle`, () => {
      expect(runInspection(kind, 'exited')).toBe(kind === 'present' ? 'absent' : kind === 'records' ? '0' : '');
    });
    it(`${kind} retains or rejects a live process whose command line cannot be read`, () => {
      const result = runInspection(kind, 'alive');
      if (kind === 'records') expect(result).toBe('1');
      else expect(result).toContain(kind === 'sweep' ? 'Cannot identify process' : 'Cannot read process command line');
    });
    it(`${kind} retains or rejects an unknown exit state`, () => {
      const result = runInspection(kind, 'unknown');
      if (kind === 'records') expect(result).toBe('1');
      else expect(result).toContain(kind === 'sweep' ? 'Cannot identify process' : 'Cannot read process command line');
    });
    it(`${kind} retains or rejects an unknown owner`, () => {
      const result = runInspection(kind, 'owner_unknown');
      if (kind === 'records') expect(result).toBe('1');
      else if (kind === 'present') expect(result).toContain('Cannot identify process');
      else expect(result === '' || result.includes('Cannot identify process')).toBe(true); // Existing elevation-dependent handling.
    });
    it(`${kind} retains or rejects an unreadable start time`, () => {
      const result = runInspection(kind, 'start_unknown');
      if (kind === 'records') expect(result).toBe('1');
      else expect(result).toContain('null-valued expression');
    });
    it(`${kind} rejects a changed process identity`, () => {
      expect(runInspection(kind, 'changed')).toContain('Process changed while inspected');
    });
  }
});
