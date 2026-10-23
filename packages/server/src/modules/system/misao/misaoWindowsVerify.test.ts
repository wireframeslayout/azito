import { describe, expect, it } from 'vitest';
import { daemonCheckScript, parseDaemonCheck, sameProgram } from './misaoWindowsVerify';

const PIPE = '\\\\.\\pipe\\misao-dev-0123456789abcdef';

describe('the check of the program behind a pipe', () => {
  it('asks Windows for the pipe server\'s process instead of matching command lines', () => {
    const script = daemonCheckScript(PIPE, 'C:\\Users\\dev\\.azito\\misao\\0.3.0\\misao.exe');
    expect(script).toContain('GetNamedPipeServerProcessId');
    expect(script).toContain('GetLongPathNameW');
    expect(script).toContain("$name = 'misao-dev-0123456789abcdef'");
    expect(script).not.toContain('CommandLine');
    // $pid is read-only in PowerShell.
    expect(script).not.toMatch(/\$pid\b/);
  });

  it('refuses something that is not a pipe path', () => {
    expect(() => daemonCheckScript('C:\\x\\misao.sock', 'C:\\x\\misao.exe')).toThrow(/named pipe/);
  });

  it('reads the two paths back and compares them without regard to case', () => {
    const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
    const same = parseDaemonCheck(`${b64('C:\\Users\\日本語\\misao.exe')}\r\n${b64('c:\\users\\日本語\\MISAO.EXE')}\r\n`);
    expect(same.actual).toBe('C:\\Users\\日本語\\misao.exe');
    expect(sameProgram(same)).toBe(true);
    expect(sameProgram({ actual: 'C:\\a\\misao.exe', expected: 'C:\\b\\misao.exe' })).toBe(false);
  });

  it('fails on an answer of another shape', () => {
    expect(() => parseDaemonCheck('')).toThrow(/unexpected answer/);
    expect(() => parseDaemonCheck('a\nb\nc')).toThrow(/unexpected answer/);
  });
});
