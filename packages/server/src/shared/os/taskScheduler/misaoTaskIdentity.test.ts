import { describe, expect, it } from 'vitest';
import path from 'path';
import { legacyMisaoTaskArgumentsOf, misaoTaskArgumentsOf } from './misaoTaskArguments';
import { misaoTaskVersion } from './misaoTaskIdentity';

describe('misao task identity', () => {
  it.each(["O'Neil", 'A’B'])('recognises both task forms for a path containing %s', (name) => {
    const root = `C:\\Users\\${name}\\misao`;
    const input = { systemRoot: 'C:\\Windows', root, exe: path.win32.join(root, '0.3.0', 'misao.exe'), logFile: path.win32.join(root, 'misao.log'), pipe: '\\\\.\\pipe\\test' };
    for (const args of [legacyMisaoTaskArgumentsOf(input), misaoTaskArgumentsOf({ ...input, taskName: 'AzitoMisao' })]) {
      expect(misaoTaskVersion({ command: 'C:\\Windows\\System32\\conhost.exe', argumentsLine: args }, input.systemRoot, root, input.pipe, 'AzitoMisao')).toBe('0.3.0');
    }
  });

  it('recognises the legacy task even when the new command would exceed the Windows limit', () => {
    const root = `C:\\Users\\${'a'.repeat(700)}\\misao`;
    const input = { systemRoot: 'C:\\Windows', root, exe: path.win32.join(root, '0.3.0', 'misao.exe'), logFile: path.win32.join(root, 'misao.log'), pipe: '\\\\.\\pipe\\test' };
    expect(() => misaoTaskArgumentsOf({ ...input, taskName: 'AzitoMisao' })).toThrow(/limit/);
    expect(misaoTaskVersion({ command: 'C:\\Windows\\System32\\conhost.exe', argumentsLine: legacyMisaoTaskArgumentsOf(input) }, input.systemRoot, root, input.pipe, 'AzitoMisao')).toBe('0.3.0');
  });
});
