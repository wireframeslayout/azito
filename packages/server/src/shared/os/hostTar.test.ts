import { describe, expect, it } from 'vitest';
import { hostTarOf } from './hostTar';

describe('hostTarOf', () => {
  it('is the tar on PATH away from Windows', () => {
    expect(hostTarOf({ platform: 'linux', systemRoot: undefined })).toBe('tar');
    expect(hostTarOf({ platform: 'darwin', systemRoot: undefined })).toBe('tar');
  });

  it('is System32\\tar.exe by absolute path on Windows, never the tar on PATH', () => {
    const asked: string[] = [];
    const tar = hostTarOf({ platform: 'win32', systemRoot: 'C:\\Windows' }, (file) => { asked.push(file); return true; });
    expect(tar).toBe('C:\\Windows\\System32\\tar.exe');
    expect(asked).toEqual([tar]);
  });

  it('says why when it cannot be found', () => {
    expect(() => hostTarOf({ platform: 'win32', systemRoot: undefined })).toThrow(/SystemRoot is not set/);
    expect(() => hostTarOf({ platform: 'win32', systemRoot: 'C:\\Windows' }, () => false)).toThrow(/tar\.exe does not exist/);
  });
});
