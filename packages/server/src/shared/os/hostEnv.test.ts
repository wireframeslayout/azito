import os from 'os';
import { describe, it, expect, afterEach } from 'vitest';
import { resolveHostEnv, resolveCurrentHostEnv } from './hostEnv';

const base = { platform: 'linux' as const, arch: 'x64', homeDir: '/home/u', tmpDir: '/tmp', execPath: '/usr/bin/node', uid: 1000 };

describe('resolveHostEnv', () => {
  it('入力をそのまま返す', () => {
    expect(resolveHostEnv(base)).toEqual(base);
  });

  it('win32 / darwin の入力も受け付ける', () => {
    const win = { platform: 'win32' as const, arch: 'x64', homeDir: 'C:\\Users\\u', tmpDir: 'C:\\Temp', execPath: 'C:\\node\\node.exe', uid: 1000 };
    expect(resolveHostEnv(win)).toEqual(win);
    expect(resolveHostEnv({ ...base, platform: 'darwin', arch: 'arm64' }).platform).toBe('darwin');
  });

  it('未対応の platform / arch でも投げない（拒否は使う側の仕事）', () => {
    expect(resolveHostEnv({ ...base, platform: 'freebsd', arch: 'ia32' })).toMatchObject({ platform: 'freebsd', arch: 'ia32' });
  });

  it('tmpDir が空なら投げる', () => {
    expect(() => resolveHostEnv({ ...base, tmpDir: '' })).toThrow(/temp directory/);
  });

  it('homeDir が空なら投げる', () => {
    expect(() => resolveHostEnv({ ...base, homeDir: '' })).toThrow(/home directory/);
  });
});

describe('resolveCurrentHostEnv (tmpDir)', () => {
  it('os.tmpdir() をそのまま tmpDir にする', () => {
    expect(resolveCurrentHostEnv().tmpDir).toBe(os.tmpdir());
  });
});

describe('resolveCurrentHostEnv (HOME の扱い)', () => {
  const originalHome = process.env.HOME;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  // Windows の os.homedir() は HOME ではなく USERPROFILE を読む
  it.skipIf(process.platform === 'win32')('通常: HOME をそのまま homeDir にする', () => {
    process.env.HOME = '/home/someone';
    expect(resolveCurrentHostEnv().homeDir).toBe('/home/someone');
  });

  it.skipIf(process.platform === 'win32')('HOME 未設定: passwd のホームを使う（旧来の空文字 = cwd 相対にはならない）', () => {
    delete process.env.HOME;
    const env = resolveCurrentHostEnv();
    expect(env.homeDir).not.toBe('');
    expect(env.homeDir).toBe(os.homedir());
  });

  it.skipIf(process.platform === 'win32')('HOME が空文字: 起動時に投げる', () => {
    process.env.HOME = '';
    expect(() => resolveCurrentHostEnv()).toThrow(/home directory/);
  });

  it('platform / arch / execPath は実プロセスの値', () => {
    const env = resolveCurrentHostEnv();
    expect(env).toMatchObject({ platform: process.platform, arch: process.arch, execPath: process.execPath, uid: 1000 });
  });
});
