import { describe, expect, it } from 'vitest';
import { powershellEncodedArgs } from '../shellDialect';
import { KILL_CHILDREN_JOB, compressedTaskScript, decodedTaskScript, sameTaskAction } from './taskLauncher';

function action(script: string): string {
  return ['--headless', 'powershell.exe', ...powershellEncodedArgs(compressedTaskScript(script))].join(' ');
}

function withGzipOs(line: string, os: number): string {
  return line.replace(/(-EncodedCommand )([A-Za-z0-9+/=]+)$/, (_, prefix: string, encoded: string) => {
    const outer = Buffer.from(encoded, 'base64').toString('utf16le');
    const changed = outer.replace(/(\$azitoTaskGzip=')([A-Za-z0-9+/=]+)(')/, (_all, before: string, data: string, after: string) => {
      const bytes = Buffer.from(data, 'base64');
      bytes[9] = os;
      return before + bytes.toString('base64') + after;
    });
    return prefix + Buffer.from(changed, 'utf16le').toString('base64');
  });
}

describe('task launcher comparison', () => {
  it.each([3, 10, 19, 255])('accepts a script compressed on OS %s', (os) => {
    const expected = action("Write-Output 'same script'");
    const other = withGzipOs(expected, os);
    expect(sameTaskAction(other, expected)).toBe(true);
    expect(decodedTaskScript(other.split(' ').at(-1)!)).toContain('same script');
  });
  it('logs and aborts if job assignment fails', () => {
    expect(KILL_CHILDREN_JOB).toContain('try { [AzitoTaskJob]::Start() } catch { Log "job: $_"; exit 1 }');
  });

  it('writes a fixed gzip OS byte independent of the host', () => {
    const line = action('Write-Output 1');
    const encoded = /-EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(line)![1]!;
    const outer = Buffer.from(encoded, 'base64').toString('utf16le');
    const data = /\$azitoTaskGzip='([A-Za-z0-9+/=]+)'/.exec(outer)![1]!;
    expect(Buffer.from(data, 'base64')[9]).toBe(255);
  });

  it('rejects a modified wrapper or inflated script', () => {
    const expected = action('Write-Output 1');
    expect(sameTaskAction(action('Write-Output 2'), expected)).toBe(false);
    const changed = expected.replace(/(-EncodedCommand )([A-Za-z0-9+/=]+)$/, (_, prefix: string, encoded: string) => {
      const outer = Buffer.from(encoded, 'base64').toString('utf16le') + 'Write-Output unsafe\n';
      return prefix + Buffer.from(outer, 'utf16le').toString('base64');
    });
    expect(sameTaskAction(changed, expected)).toBe(false);
  });
});
