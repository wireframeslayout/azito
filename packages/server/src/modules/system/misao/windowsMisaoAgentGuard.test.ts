import { describe, expect, it, vi } from 'vitest';
import { assertNoWindowsAgent, buildMisaoAgentGuardScript } from './windowsMisaoAgentGuard';

describe('Windows agent absence guard', () => {
  it('accepts only an explicit clear result', async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'CLEAR\r\n', stderr: '' });
    await expect(assertNoWindowsAgent(run, 'C:\\Windows', 'C:\\Users\\me\\misao', 'AzitoMisao', 123, 456)).resolves.toBeUndefined();
  });

  it.each(['AGENT process 42', 'AGENT task custom-agent', 'UNKNOWN process 17', 'UNKNOWN task opaque-task', 'garbled'])('refuses %s', async (answer) => {
    const run = vi.fn().mockResolvedValue({ exitCode: 0, stdout: answer, stderr: '' });
    await expect(assertNoWindowsAgent(run, 'C:\\Windows', 'C:\\Users\\me\\misao', 'AzitoMisao', 123, 456)).rejects.toThrow(/agent use/i);
  });

  it('refuses a failed process or task query', async () => {
    const run = vi.fn().mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'access denied' });
    await expect(assertNoWindowsAgent(run, 'C:\\Windows', 'C:\\Users\\me\\misao', 'AzitoMisao', 123, 456)).rejects.toThrow(/access denied/);
  });

  it('checks all tasks, decodes commands, and rejects unknown node and interpreter actions', () => {
    const script = buildMisaoAgentGuardScript('C:\\Windows', 'C:\\Users\\me\\misao', 'AzitoMisao', 123, 456);
    expect(script).toContain('Get-ScheduledTask -ErrorAction Stop');
    expect(script).toContain('FromBase64String');
    expect(script).toContain('$p.ProcessId -eq 123');
    expect(script).toContain('$p.ProcessId -eq 456');
    expect(script).toContain("$p.CommandLine -match '~[0-9]+'");
    expect(script).toContain('-not $systemAccount');
    expect(script).toContain('Test-TaskEnumerationAuthority');
    expect(script).toContain('Test-TaskListComplete');
    expect(script).toContain('ReparsePoint');
    expect(script).toContain('[string]::Equals($p.ExecutablePath, $misaoExe');
  });
});
