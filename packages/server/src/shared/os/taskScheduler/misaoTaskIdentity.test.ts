import { describe, expect, it } from 'vitest';
import path from 'path';
import { legacyMisaoTaskArgumentsOf, misaoTaskArgumentsOf } from './misaoTaskArguments';
import { taskHasUserId } from './taskXmlRead';
import { misaoTaskVersion } from './misaoTaskIdentity';

function differentOs(line: string): string {
  return line.replace(/(-EncodedCommand )([A-Za-z0-9+/=]+)$/, (_all, prefix: string, encoded: string) => {
    const outer = Buffer.from(encoded, 'base64').toString('utf16le');
    const updated = outer.replace(/(\$azitoTaskGzip=')([A-Za-z0-9+/=]+)(')/, (_m, a: string, payload: string, b: string) => {
      const bytes = Buffer.from(payload, 'base64'); bytes[9] = 10; return a + bytes.toString('base64') + b;
    });
    return prefix + Buffer.from(updated, 'utf16le').toString('base64');
  });
}

describe('misao task identity', () => {
  it.each(["O'Neil", 'A’B'])('recognises both task forms for a path containing %s', (name) => {
    const root = `C:\\Users\\${name}\\misao`;
    const input = { systemRoot: 'C:\\Windows', root, exe: path.win32.join(root, '0.3.0', 'misao.exe'), logFile: path.win32.join(root, 'misao.log'), pipe: '\\\\.\\pipe\\test' };
    for (const args of [legacyMisaoTaskArgumentsOf(input), misaoTaskArgumentsOf({ ...input, taskName: 'AzitoMisao' })]) {
      expect(misaoTaskVersion({ command: 'C:\\Windows\\System32\\conhost.exe', argumentsLine: args }, input.systemRoot, root, input.pipe, 'AzitoMisao')).toBe('0.3.0');
    }
  });

  it('recognises a new task compressed by a hub on another OS', () => {
    const root = 'C:\\Users\\dev\\misao';
    const input = { systemRoot: 'C:\\Windows', root, exe: path.win32.join(root, '0.3.0', 'misao.exe'), logFile: path.win32.join(root, 'misao.log'), pipe: '\\\\.\\pipe\\test' };
    const args = misaoTaskArgumentsOf({ ...input, taskName: 'AzitoMisao' });
    expect(misaoTaskVersion({ command: 'C:\\Windows\\System32\\conhost.exe', argumentsLine: differentOs(args) }, input.systemRoot, root, input.pipe, 'AzitoMisao')).toBe('0.3.0');
  });

  it('recognises the legacy task even when the new command would exceed the Windows limit', () => {
    const root = `C:\\Users\\${'a'.repeat(700)}\\misao`;
    const input = { systemRoot: 'C:\\Windows', root, exe: path.win32.join(root, '0.3.0', 'misao.exe'), logFile: path.win32.join(root, 'misao.log'), pipe: '\\\\.\\pipe\\test' };
    expect(misaoTaskVersion({ command: 'C:\\Windows\\System32\\conhost.exe', argumentsLine: legacyMisaoTaskArgumentsOf(input) }, input.systemRoot, root, input.pipe, 'AzitoMisao')).toBe('0.3.0');
  });
});

describe('task principal identity', () => {
  it('recognises a scheduler-exported SID only when it matches the independently resolved user SID', () => {
    const xml = '<Task><Principals><Principal id="Author"><UserId>S-1-5-21-12-34-500</UserId></Principal></Principals></Task>';
    expect(taskHasUserId(xml, 'PC\\dev')).toBe(false);
    expect(taskHasUserId(xml, 'PC\\dev', 'S-1-5-21-12-34-500')).toBe(true);
    expect(taskHasUserId(xml, 'PC\\dev', 'S-1-5-21-12-34-501')).toBe(false);
  });
});
