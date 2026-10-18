import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSecretFileGuard, UnixSecretFileGuard } from './secretFileGuard';
import { WindowsSecretFileGuard } from './windowsSecretFileGuard';

describe('createSecretFileGuard', () => {
  it('win32 だけ Windows 実装、それ以外は Unix 実装', () => {
    expect(createSecretFileGuard('win32')).toBeInstanceOf(WindowsSecretFileGuard);
    expect(createSecretFileGuard('linux')).toBeInstanceOf(UnixSecretFileGuard);
    expect(createSecretFileGuard('darwin')).toBeInstanceOf(UnixSecretFileGuard);
  });
});

describe.skipIf(process.platform === 'win32')('UnixSecretFileGuard', () => {
  const guard = new UnixSecretFileGuard();
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-guard-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const modeOf = (p: string): number => fs.statSync(p).mode & 0o777;

  it('ensureProtectedDir は新規も既存も 700 にする', () => {
    const fresh = path.join(dir, 'a', 'b');
    guard.ensureProtectedDir(fresh);
    expect(modeOf(fresh)).toBe(0o700);

    const loose = path.join(dir, 'loose');
    fs.mkdirSync(loose, { mode: 0o755 });
    fs.chmodSync(loose, 0o755);
    guard.ensureProtectedDir(loose);
    expect(modeOf(loose)).toBe(0o700);
  });

  it('writeSecretFile は新規を 600 で作り、親ディレクトリが無ければ 700 で作る', () => {
    const file = path.join(dir, 'sub', 'secret');
    guard.writeSecretFile(file, 'v1');
    expect(fs.readFileSync(file, 'utf-8')).toBe('v1');
    expect(modeOf(file)).toBe(0o600);
    expect(modeOf(path.dirname(file))).toBe(0o700);
  });

  it('writeSecretFile は緩い既存ファイルを 600 に締めて置き換える', () => {
    const file = path.join(dir, 'secret');
    fs.writeFileSync(file, 'old', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    guard.writeSecretFile(file, 'new');
    expect(fs.readFileSync(file, 'utf-8')).toBe('new');
    expect(modeOf(file)).toBe(0o600);
  });

  it('appendSecretFile は新規を 600 で作って追記する', () => {
    const file = path.join(dir, 'log');
    guard.appendSecretFile(file, 'a\n');
    guard.appendSecretFile(file, 'b\n');
    expect(fs.readFileSync(file, 'utf-8')).toBe('a\nb\n');
    expect(modeOf(file)).toBe(0o600);
  });

  it('protectFile は無いファイルで投げ、repairFile は無いファイルを無視して緩いファイルを直す', () => {
    const missing = path.join(dir, 'missing');
    expect(() => guard.protectFile(missing)).toThrow();
    expect(() => guard.repairFile(missing)).not.toThrow();

    const file = path.join(dir, 'secret');
    fs.writeFileSync(file, 'x');
    fs.chmodSync(file, 0o664);
    guard.repairFile(file);
    expect(modeOf(file)).toBe(0o600);
  });

  it('inspect は 600（ファイル）/ 700（ディレクトリ）を ok とし、違えば理由と修正コマンドを返す', () => {
    const file = path.join(dir, 'secret');
    fs.writeFileSync(file, 'x');
    fs.chmodSync(file, 0o644);
    expect(guard.inspect(file, 'file')).toEqual({ ok: false, summary: 'パーミッションが 644 です。', fix: `chmod 600 ${file}` });
    fs.chmodSync(file, 0o600);
    expect(guard.inspect(file, 'file')).toEqual({ ok: true });

    fs.chmodSync(dir, 0o755);
    expect(guard.inspect(dir, 'dir')).toEqual({ ok: false, summary: 'パーミッションが 755 です。', fix: `chmod 700 ${dir}` });
    fs.chmodSync(dir, 0o700);
    expect(guard.inspect(dir, 'dir')).toEqual({ ok: true });
  });
});
