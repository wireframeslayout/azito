import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  body = body.replace('text.buffer == IntPtr.Zero ? null : Marshal.PtrToStringUni(text.buffer, text.length / 2)', 'null');
  if (state === 'owner_unknown') body = body.replace(/\[AzitoProcessList\]::Owner\([^)]*\)/g, '$null');
  if (state === 'unknown') body = body.replace('GetExitCodeProcess(h, out code) ? (bool?)(code != 259) : null', 'null');
  const script = `
$ErrorActionPreference = 'Stop'
$child = Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile -NonInteractive -Command Start-Sleep -Seconds 30' -PassThru
try {
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
} finally { if (-not $child.HasExited) { Stop-Process -Id $child.Id -Force }; $child.Dispose() }
`;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'azito-process-test-'));
  try {
    const file = path.join(dir, 'test.ps1');
    writeFileSync(file, script);
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', file], { encoding: 'utf8', timeout: 30000 });
    return result.status === 0 ? result.stdout.trim() : `ERROR: ${result.stderr}`;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe.skipIf(process.platform !== 'win32')('process inspections with real Windows processes', () => {
  for (const kind of ['sweep', 'present', 'records'] as const) {
    it(`${kind} excludes an exited process with an open handle`, () => {
      expect(runInspection(kind, 'exited')).toBe(kind === 'present' ? 'absent' : kind === 'records' ? '0' : '');
    });
    it(`${kind} retains or rejects a live process whose command line cannot be read`, () => {
      const result = runInspection(kind, 'alive');
      if (kind === 'records') expect(result).toBe('1');
      else expect(result).toMatch(/^ERROR:/);
    });
    it(`${kind} retains or rejects an unknown exit state`, () => {
      const result = runInspection(kind, 'unknown');
      if (kind === 'records') expect(result).toBe('1');
      else expect(result).toMatch(/^ERROR:/);
    });
    it(`${kind} retains or rejects an unknown owner`, () => {
      const result = runInspection(kind, 'owner_unknown');
      if (kind === 'records') expect(result).toBe('1');
      else if (kind === 'present') expect(result).toMatch(/^ERROR:/);
      else expect(result === '' || result.startsWith('ERROR:')).toBe(true); // Existing elevation-dependent handling.
    });
    it(`${kind} retains or rejects an unreadable start time`, () => {
      const result = runInspection(kind, 'start_unknown');
      if (kind === 'records') expect(result).toBe('1');
      else expect(result).toMatch(/^ERROR:/);
    });
    it(`${kind} rejects a changed process identity`, () => {
      expect(runInspection(kind, 'changed')).toMatch(/^ERROR:/);
    });
  }
});
