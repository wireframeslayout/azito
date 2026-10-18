import { describe, it, expect } from 'vitest';
import { resolveHostEnv, resolveCurrentHostEnv } from './hostEnv';

const base = { platform: 'linux', arch: 'x64', homeDir: '/home/u', tmpDir: '/tmp', execPath: '/usr/bin/node' };

describe('resolveHostEnv', () => {
  it('linux は区切りが : で入力をそのまま返す', () => {
    expect(resolveHostEnv(base)).toEqual({ ...base, pathDelimiter: ':' });
  });

  it('darwin / arm64 を受け付ける', () => {
    const env = resolveHostEnv({ ...base, platform: 'darwin', arch: 'arm64', homeDir: '/Users/u' });
    expect(env).toMatchObject({ platform: 'darwin', arch: 'arm64', pathDelimiter: ':' });
  });

  it('win32 は区切りが ; になる', () => {
    const env = resolveHostEnv({
      platform: 'win32', arch: 'x64', homeDir: 'C:\\Users\\u', tmpDir: 'C:\\Temp', execPath: 'C:\\node\\node.exe',
    });
    expect(env.pathDelimiter).toBe(';');
    expect(env.homeDir).toBe('C:\\Users\\u');
  });

  it('未対応の platform は理由付きで投げる', () => {
    expect(() => resolveHostEnv({ ...base, platform: 'freebsd' })).toThrow(/Unsupported platform "freebsd"/);
  });

  it('未対応の arch は理由付きで投げる', () => {
    expect(() => resolveHostEnv({ ...base, arch: 'ia32' })).toThrow(/Unsupported architecture "ia32"/);
  });

  it('homeDir が空なら投げる', () => {
    expect(() => resolveHostEnv({ ...base, homeDir: '' })).toThrow(/home directory/);
  });
});

describe('resolveCurrentHostEnv', () => {
  it('実プロセスの値を返す', () => {
    const env = resolveCurrentHostEnv();
    expect(env.execPath).toBe(process.execPath);
    expect(env.homeDir).not.toBe('');
  });
});
