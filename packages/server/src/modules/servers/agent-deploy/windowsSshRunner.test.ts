import { describe, expect, it, vi } from 'vitest';
import { buildCommandSpec } from '../../../shared/exec/commandSpec';
import { decodeEncodedCommand } from './testing/fakeWindowsHost';
import { createSshCommandSpecRunner, parseRunOutput } from './windowsSshRunner';

const output = (r: object) => `banner\r\n<<AZITO_RUN_BEGIN>>\r\n${JSON.stringify(r)}\r\n<<AZITO_RUN_END>>\r\n`;

describe('createSshCommandSpecRunner', () => {
  it('sends the program and its arguments as a PowerShell EncodedCommand (no shell line) and returns the raw bytes', async () => {
    const oem = Buffer.from([0x8e, 0x73, 0x8d, 0x73]); // not UTF-8: it must survive untouched
    const exec = vi.fn(async (_command: string, _timeoutMs: number) => ({ stdout: output({ exitCode: 1, stdout: oem.toString('base64'), stderr: '' }), stderr: '', code: 0 }));
    const run = createSshCommandSpecRunner(exec);
    const result = await run(buildCommandSpec('C:\\Windows\\System32\\schtasks.exe', ['/Run', '/TN', 'a b', "it's"], { timeoutMs: 5000 }));

    expect(result.exitCode).toBe(1);
    expect(result.stdout.equals(oem)).toBe(true);
    expect(result.stderr.length).toBe(0);
    const [command, timeoutMs] = exec.mock.calls[0]!;
    expect(command).toMatch(/^powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand /);
    expect(timeoutMs).toBeGreaterThan(5000);
    const script = decodeEncodedCommand(command);
    expect(script).toContain("$psi.FileName = 'C:\\Windows\\System32\\schtasks.exe'");
    expect(script).toContain(`$psi.Arguments = '/Run /TN "a b" it''s'`);
    expect(script).toContain('UseShellExecute = $false');
  });

  it('refuses a spec with cwd, env or stdin (it cannot carry them)', async () => {
    const run = createSshCommandSpecRunner(vi.fn());
    await expect(run(buildCommandSpec('x.exe', [], { cwd: 'C:\\' }))).rejects.toThrow(/does not support cwd, env or stdin/);
    await expect(run(buildCommandSpec('x.exe', [], { env: { A: 'b' } }))).rejects.toThrow(/does not support/);
  });
});

describe('parseRunOutput', () => {
  it('reads the result between the markers whatever surrounds them', () => {
    const r = parseRunOutput(output({ exitCode: 0, stdout: Buffer.from('ok').toString('base64'), stderr: '' }), '', 0);
    expect(r.stdout.toString()).toBe('ok');
  });

  it('throws with the (redacted) output when the markers are missing', () => {
    expect(() => parseRunOutput('Permission denied', 'x', 255)).toThrow(/gave no result \(ssh exit 255; got: Permission denied/);
  });

  it('throws for a result that is not the expected shape', () => {
    expect(() => parseRunOutput('<<AZITO_RUN_BEGIN>>\n{"exitCode":"x"}\n<<AZITO_RUN_END>>', '', 0)).toThrow(/unexpected result/);
    expect(() => parseRunOutput('<<AZITO_RUN_BEGIN>>\nnope\n<<AZITO_RUN_END>>', '', 0)).toThrow(/not JSON/);
  });
});
