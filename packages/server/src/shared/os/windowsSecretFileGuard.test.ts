import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  evaluateAcl,
  parseAclSnapshot,
  WindowsSecretFileGuard,
  type AclEntry,
  type PowerShellRunner,
} from './windowsSecretFileGuard';

const ME = 'S-1-5-21-1-2-3-1001';
const allow = (sid: string, name = sid): AclEntry => ({ sid, name, type: 'Allow', inherited: false });

describe('parseAclSnapshot', () => {
  it('エントリが 1 つのとき（配列でなくオブジェクト）も配列にそろえる', () => {
    const json = JSON.stringify({ currentSid: ME, entries: { sid: ME, name: 'PC\\me', type: 'Allow', inherited: true } });
    expect(parseAclSnapshot(json)).toEqual({ currentSid: ME, entries: [{ sid: ME, name: 'PC\\me', type: 'Allow', inherited: true }] });
  });

  it('現在のユーザーの SID が無ければ投げる', () => {
    expect(() => parseAclSnapshot(JSON.stringify({ entries: [] }))).toThrow('current user SID');
  });
});

describe('evaluateAcl', () => {
  it('現在のユーザーだけの許可なら ok（継承されたものも可）', () => {
    expect(evaluateAcl({ currentSid: ME, entries: [{ ...allow(ME), inherited: true }] }, 'C:\\f', 'file')).toEqual({ ok: true });
  });

  it('他のユーザーの許可があれば、その名前と修正コマンドを返す', () => {
    const result = evaluateAcl({ currentSid: ME, entries: [allow(ME), allow('S-1-5-32-545', 'BUILTIN\\Users')] }, 'C:\\f', 'file');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.summary).toContain('BUILTIN\\Users');
    expect(result.fix).toBe(`icacls "C:\\f" /inheritance:r /remove:g *S-1-5-32-545 /grant:r "*${ME}:F"`);
  });

  it('ディレクトリの修正コマンドは子へ継承させる', () => {
    const result = evaluateAcl({ currentSid: ME, entries: [allow('S-1-1-0', 'Everyone')] }, 'C:\\d', 'dir');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fix).toContain(`"*${ME}:(OI)(CI)F"`);
  });

  it('SYSTEM / Administrators も許可があれば違反、拒否エントリは見ない', () => {
    expect(evaluateAcl({ currentSid: ME, entries: [allow(ME), allow('S-1-5-18', 'NT AUTHORITY\\SYSTEM')] }, 'C:\\f', 'file').ok).toBe(false);
    expect(evaluateAcl({ currentSid: ME, entries: [allow(ME), { ...allow('S-1-1-0'), type: 'Deny' }] }, 'C:\\f', 'file')).toEqual({ ok: true });
  });

  it('現在のユーザーの許可が無い（ロックアウト）も違反', () => {
    expect(evaluateAcl({ currentSid: ME, entries: [] }, 'C:\\f', 'file').ok).toBe(false);
  });

  it('解決できない主体（sid が空）は違反として報告する', () => {
    expect(evaluateAcl({ currentSid: ME, entries: [allow(ME), allow('', '')] }, 'C:\\f', 'file').ok).toBe(false);
  });
});

describe('WindowsSecretFileGuard（保護に失敗したら秘密を書かない。実行器を差し替えるので全 OS で動く）', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-wguard-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const failing: PowerShellRunner = () => { throw new Error('access denied'); };

  it('writeSecretFile: 保護に失敗したら中身を書かず、一時ファイルも残さない', () => {
    const guard = new WindowsSecretFileGuard(failing);
    const target = path.join(dir, 'master.key');
    expect(() => guard.writeSecretFile(target, 'SECRET')).toThrow('access denied');
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('writeSecretFile: 保護に失敗したら既存ファイルの中身も変えない', () => {
    const guard = new WindowsSecretFileGuard(failing);
    const target = path.join(dir, 'master.key');
    fs.writeFileSync(target, 'OLD');
    expect(() => guard.writeSecretFile(target, 'NEW')).toThrow('access denied');
    expect(fs.readFileSync(target, 'utf-8')).toBe('OLD');
    expect(fs.readdirSync(dir)).toEqual(['master.key']);
  });

  it('appendSecretFile: 新規ファイルの保護に失敗したら書かず、空のファイルも残さない', () => {
    const guard = new WindowsSecretFileGuard(failing);
    const target = path.join(dir, 'update.log');
    expect(() => guard.appendSecretFile(target, 'SECRET\n')).toThrow('access denied');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('writeSecretFile: 保護してから書く（実行器が呼ばれた時点で中身はまだ空）', () => {
    const seen: string[] = [];
    const guard = new WindowsSecretFileGuard((_script, targetPath) => {
      seen.push(fs.readFileSync(targetPath, 'utf-8'));
      return '';
    });
    const target = path.join(dir, 'ui-token');
    guard.writeSecretFile(target, 'SECRET');
    expect(seen).toEqual(['']);
    expect(fs.readFileSync(target, 'utf-8')).toBe('SECRET');
    expect(fs.readdirSync(dir)).toEqual(['ui-token']);
  });

  it('repairFile: 無いファイルは実行器を呼ばず何もしない', () => {
    let called = false;
    const guard = new WindowsSecretFileGuard(() => { called = true; return ''; });
    guard.repairFile(path.join(dir, 'missing'));
    expect(called).toBe(false);
  });
});

function icaclsOutput(target: string): string {
  return execFileSync('icacls', [target], { encoding: 'utf8' });
}

describe.skipIf(process.platform !== 'win32')('WindowsSecretFileGuard（実際の ACL）', () => {
  const guard = new WindowsSecretFileGuard();
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-wguard-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('緩い ACL（Users / Everyone の明示的な許可）を inspect が検出する', () => {
    const file = path.join(dir, 'loose');
    fs.writeFileSync(file, 'x');
    execFileSync('icacls', [file, '/grant', '*S-1-5-32-545:R', '/grant', '*S-1-1-0:R']);
    expect(guard.inspect(file, 'file').ok).toBe(false);
  });

  it('protectFile は既存の明示的な許可（Users / Everyone）も継承も除き、現在のユーザーだけにする', () => {
    const file = path.join(dir, 'loose');
    fs.writeFileSync(file, 'x');
    execFileSync('icacls', [file, '/grant', '*S-1-5-32-545:R', '/grant', '*S-1-1-0:R']);
    guard.protectFile(file);
    expect(guard.inspect(file, 'file')).toEqual({ ok: true });
    const out = icaclsOutput(file);
    expect(out).not.toMatch(/Everyone/i);
    expect(out).not.toMatch(/BUILTIN\\Users/i);
    expect(out).not.toMatch(/SYSTEM/i);
    expect(out).not.toMatch(/Administrators/i);
  });

  it('writeSecretFile は新規も置き換えも現在のユーザーだけにして、中身を書く', () => {
    const file = path.join(dir, 'master.key');
    guard.writeSecretFile(file, 'one');
    expect(fs.readFileSync(file, 'utf-8')).toBe('one');
    expect(guard.inspect(file, 'file')).toEqual({ ok: true });

    execFileSync('icacls', [file, '/grant', '*S-1-1-0:R']);
    expect(guard.inspect(file, 'file').ok).toBe(false);
    guard.writeSecretFile(file, 'two');
    expect(fs.readFileSync(file, 'utf-8')).toBe('two');
    expect(guard.inspect(file, 'file')).toEqual({ ok: true });
    expect(fs.readdirSync(dir)).toEqual(['master.key']);
  });

  it('ensureProtectedDir の保護は中に作ったファイルとディレクトリに継承される', () => {
    const data = path.join(dir, 'data');
    guard.ensureProtectedDir(data);
    expect(guard.inspect(data, 'dir')).toEqual({ ok: true });

    const child = path.join(data, 'data.db');
    fs.writeFileSync(child, 'x');
    expect(guard.inspect(child, 'file')).toEqual({ ok: true });

    const sub = path.join(data, 'browser-profile');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'Cookies'), 'x');
    expect(guard.inspect(path.join(sub, 'Cookies'), 'file')).toEqual({ ok: true });
  });

  it('ensureProtectedDir は緩い既存ディレクトリも直す', () => {
    const data = path.join(dir, 'data');
    fs.mkdirSync(data);
    execFileSync('icacls', [data, '/grant', '*S-1-1-0:(OI)(CI)R']);
    expect(guard.inspect(data, 'dir').ok).toBe(false);
    guard.ensureProtectedDir(data);
    expect(guard.inspect(data, 'dir')).toEqual({ ok: true });
  });

  it('writeSecretFile: 親ディレクトリが無ければ作って保護する', () => {
    const file = path.join(dir, 'fresh', 'ui-token');
    guard.writeSecretFile(file, 'tok');
    expect(guard.inspect(path.dirname(file), 'dir')).toEqual({ ok: true });
    expect(guard.inspect(file, 'file')).toEqual({ ok: true });
  });

  it('appendSecretFile は新規ファイルを保護して追記する', () => {
    const file = path.join(dir, 'update.log');
    guard.appendSecretFile(file, 'a\n');
    guard.appendSecretFile(file, 'b\n');
    expect(fs.readFileSync(file, 'utf-8')).toBe('a\nb\n');
    expect(guard.inspect(file, 'file')).toEqual({ ok: true });
  });

  it('repairFile は緩いファイルを直し、無いファイルは無視する', () => {
    const file = path.join(dir, 'ui-token');
    fs.writeFileSync(file, 'x');
    guard.repairFile(file);
    expect(guard.inspect(file, 'file')).toEqual({ ok: true });
    expect(() => guard.repairFile(path.join(dir, 'missing'))).not.toThrow();
  });
});
