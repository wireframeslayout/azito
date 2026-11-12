import { describe, expect, it } from 'vitest';
import { WINDOWS_PROCESS_INFO, WINDOWS_PROCESS_RECORDS } from './windowsProcessInfo';
import { buildEndProcessesScript, buildProcessPresentScript } from './windowsProcessSweep';

describe('Windows process exit checks', () => {
  it('reads exit status on the same handle and treats failures as unknown', () => {
    expect(WINDOWS_PROCESS_INFO).toContain('GetExitCodeProcess(h, out code) ? (bool?)(code != 259) : null');
    expect(WINDOWS_PROCESS_INFO).toContain('return new object[] { 0, null, null }');
    expect(WINDOWS_PROCESS_INFO).toContain('return Result(h, parent, null)');
  });

  it('checks identity and owner before excluding an exited process from records', () => {
    const script = WINDOWS_PROCESS_RECORDS.join('\n');
    expect(script).toContain('$current.StartTime.ToUniversalTime() -ne $started');
    expect(script).toContain('$started -and $owner -and $info[2] -eq $true');
  });

  it('only excludes confirmed exits after identity checks in sweep and presence scripts', () => {
    const sweep = buildEndProcessesScript({ image: 'node.exe', argument: 'agent.env', label: 'agent', endParentConhost: true });
    const present = buildProcessPresentScript('powershell.exe', '', ['launcher']);
    expect(sweep).toContain("if ($current.StartTime.ToUniversalTime() -ne $started) { throw 'Process changed while inspected' }; if ($owner -and $data[2] -eq $true) { return }");
    expect(sweep).toContain('if (-not $n.Owner -or -not $n.CommandLine) { throw');
    expect(present.indexOf('if ($current.StartTime.ToUniversalTime() -ne $started)')).toBeLessThan(present.indexOf('if ($owner -and $data[2] -eq $true)'));
    expect(present).toContain('if (-not $data[1]) { throw "Cannot read process command line" }');
  });
});
