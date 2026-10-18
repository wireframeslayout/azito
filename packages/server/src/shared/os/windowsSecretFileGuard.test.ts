import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/Database';
import {
  createPowerShellRunner,
  evaluateAcl,
  parseAclSnapshot,
  resolveWindowsPowerShellPath,
  WindowsSecretFileGuard,
  type AclEntry,
  type PowerShellRunner,
} from './windowsSecretFileGuard';

const ME = 'S-1-5-21-1-2-3-1001';
const allow = (sid: string, name = sid): AclEntry => ({ sid, name, type: 'Allow', inherited: false });
const snap = (entries: AclEntry[], ownerSid = ME): { currentSid: string; ownerSid: string; entries: AclEntry[] } => ({ currentSid: ME, ownerSid, entries });

describe('parseAclSnapshot', () => {
  it('エントリが 1 つのとき（配列でなくオブジェクト）も配列にそろえる', () => {
    const json = JSON.stringify({ currentSid: ME, ownerSid: ME, entries: { sid: ME, name: 'PC\\me', type: 'Allow', inherited: true } });
    expect(parseAclSnapshot(json)).toEqual(snap([{ sid: ME, name: 'PC\\me', type: 'Allow', inherited: true }]));
  });

  it('現在のユーザーの SID が無ければ投げる', () => {
    expect(() => parseAclSnapshot(JSON.stringify({ entries: [] }))).toThrow('current user SID');
  });
});

describe('evaluateAcl', () => {
  it('現在のユーザーだけの許可で所有者も本人なら ok（継承されたものも可）', () => {
    expect(evaluateAcl(snap([{ ...allow(ME), inherited: true }]), 'C:\\f', 'file')).toEqual({ ok: true });
  });

  it('他のユーザーの許可があれば、その名前と修正コマンドを返す', () => {
    const result = evaluateAcl(snap([allow(ME), allow('S-1-5-32-545', 'BUILTIN\\Users')]), 'C:\\f', 'file');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.summary).toContain('BUILTIN\\Users');
    expect(result.fix).toBe(`icacls "C:\\f" /inheritance:r /remove:g *S-1-5-32-545 /grant:r "*${ME}:F"`);
  });

  it('所有者が現在のユーザーでなければ違反とし、修正コマンドに /setowner を加える', () => {
    const result = evaluateAcl(snap([allow(ME)], 'S-1-5-32-544'), 'C:\\f', 'file');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.summary).toContain('所有者');
    expect(result.fix).toBe(`icacls "C:\\f" /inheritance:r /setowner *${ME} /grant:r "*${ME}:F"`);
  });

  it('ディレクトリの修正コマンドは子へ継承させる', () => {
    const result = evaluateAcl(snap([allow('S-1-1-0', 'Everyone')]), 'C:\\d', 'dir');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fix).toContain(`"*${ME}:(OI)(CI)F"`);
  });

  it('SYSTEM / Administrators も許可があれば違反、拒否エントリは見ない', () => {
    expect(evaluateAcl(snap([allow(ME), allow('S-1-5-18', 'NT AUTHORITY\\SYSTEM')]), 'C:\\f', 'file').ok).toBe(false);
    expect(evaluateAcl(snap([allow(ME), { ...allow('S-1-1-0'), type: 'Deny' }]), 'C:\\f', 'file')).toEqual({ ok: true });
  });

  it('現在のユーザーの許可が無い（ロックアウト）も違反', () => {
    expect(evaluateAcl(snap([]), 'C:\\f', 'file').ok).toBe(false);
  });

  it('解決できない主体（sid が空）は違反として報告する', () => {
    expect(evaluateAcl(snap([allow(ME), allow('', '')]), 'C:\\f', 'file').ok).toBe(false);
  });
});

describe('resolveWindowsPowerShellPath', () => {
  it('SystemRoot から絶対パスを作り、無ければ投げる', () => {
    expect(resolveWindowsPowerShellPath({ SystemRoot: 'C:\\Windows' })).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(() => resolveWindowsPowerShellPath({})).toThrow('SystemRoot');
  });
});

describe('WindowsSecretFileGuard（実行器を差し替えるので全 OS で動く）', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-wguard-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const make = (run: PowerShellRunner, extra: Partial<ConstructorParameters<typeof WindowsSecretFileGuard>[0]> = {}): WindowsSecretFileGuard =>
    new WindowsSecretFileGuard({ powershellPath: 'powershell.exe', env: {}, run, sleep: () => {}, ...extra });
  /** 保護済みの空ファイルの作成（CREATE_SCRIPT）を、fs で真似る実行器。 */
  const fakeRun = (calls: string[] = []): PowerShellRunner => (script, p) => {
    const kind = script.includes('CreateNew') ? 'create' : 'protect';
    calls.push(`${kind}:${path.basename(p)}`);
    if (kind === 'create') fs.writeFileSync(p, '', { flag: 'wx' });
    return '';
  };
  const failing: PowerShellRunner = () => { throw new Error('access denied'); };

  it('writeSecretFile: 保護に失敗したら中身を書かず、一時ファイルも残さない', () => {
    const target = path.join(dir, 'master.key');
    expect(() => make(failing).writeSecretFile(target, 'SECRET')).toThrow('access denied');
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('writeSecretFile: 保護に失敗したら既存ファイルの中身も変えない', () => {
    const target = path.join(dir, 'master.key');
    fs.writeFileSync(target, 'OLD');
    expect(() => make(failing).writeSecretFile(target, 'NEW')).toThrow('access denied');
    expect(fs.readFileSync(target, 'utf-8')).toBe('OLD');
    expect(fs.readdirSync(dir)).toEqual(['master.key']);
  });

  it('writeSecretFile: 保護付きで作った一時ファイルに書いて置き換える', () => {
    const calls: string[] = [];
    const target = path.join(dir, 'ui-token');
    make(fakeRun(calls)).writeSecretFile(target, 'SECRET');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^create:\.ui-token\..*\.tmp$/);
    expect(fs.readFileSync(target, 'utf-8')).toBe('SECRET');
    expect(fs.readdirSync(dir)).toEqual(['ui-token']);
  });

  it('writeSecretFile: rename が EBUSY / EPERM / EACCES で失敗しても数回やり直し、成功すれば置き換わる', () => {
    let attempts = 0;
    const target = path.join(dir, 'ui-token');
    const guard = make(fakeRun(), {
      rename: (from, to) => {
        attempts++;
        if (attempts < 3) throw Object.assign(new Error('busy'), { code: ['EBUSY', 'EPERM'][attempts - 1] });
        fs.renameSync(from, to);
      },
    });
    guard.writeSecretFile(target, 'SECRET');
    expect(attempts).toBe(3);
    expect(fs.readFileSync(target, 'utf-8')).toBe('SECRET');
  });

  it('writeSecretFile: rename が続けて失敗したら投げて一時ファイルを残さず、別のエラーはやり直さない', () => {
    const target = path.join(dir, 'ui-token');
    let attempts = 0;
    const always = make(fakeRun(), { rename: () => { attempts++; throw Object.assign(new Error('locked'), { code: 'EACCES' }); } });
    expect(() => always.writeSecretFile(target, 'SECRET')).toThrow('locked');
    expect(attempts).toBe(6);
    expect(fs.readdirSync(dir)).toEqual([]);

    attempts = 0;
    const other = make(fakeRun(), { rename: () => { attempts++; throw Object.assign(new Error('nope'), { code: 'ENOENT' }); } });
    expect(() => other.writeSecretFile(target, 'SECRET')).toThrow('nope');
    expect(attempts).toBe(1);
  });

  it('appendSecretFile: 新規ファイルの保護に失敗したら書かず、空のファイルも残さない', () => {
    const target = path.join(dir, 'update.log');
    expect(() => make(failing).appendSecretFile(target, 'SECRET\n')).toThrow('access denied');
    expect(fs.existsSync(target)).toBe(false);
  });

  it('appendSecretFile: 既存ファイルはそのプロセスの最初の追記の前に 1 回だけ保護し、失敗したら追記しない', () => {
    const target = path.join(dir, 'update.log');
    fs.writeFileSync(target, 'old\n');
    expect(() => make(failing).appendSecretFile(target, 'SECRET\n')).toThrow('access denied');
    expect(fs.readFileSync(target, 'utf-8')).toBe('old\n');

    const calls: string[] = [];
    const guard = make(fakeRun(calls));
    guard.appendSecretFile(target, 'a\n');
    guard.appendSecretFile(target, 'b\n');
    expect(calls).toEqual(['protect:update.log']);
    expect(fs.readFileSync(target, 'utf-8')).toBe('old\na\nb\n');
  });

  it('prepareFile: 無ければ保護した空ファイルを作り、あれば保護し直す', () => {
    const calls: string[] = [];
    const guard = make(fakeRun(calls));
    guard.prepareFile(path.join(dir, 'data.db-wal'));
    expect(fs.readFileSync(path.join(dir, 'data.db-wal'), 'utf-8')).toBe('');
    fs.writeFileSync(path.join(dir, 'data.db-shm'), 'x');
    guard.prepareFile(path.join(dir, 'data.db-shm'));
    expect(calls).toEqual(['create:data.db-wal', 'protect:data.db-shm']);
  });

  it('repairFile: 無いファイルでは実行器を呼ばず、あるファイルは（直前に保護していても）毎回保護する', () => {
    const calls: string[] = [];
    const guard = make(fakeRun(calls));
    guard.repairFile(path.join(dir, 'missing'));
    guard.prepareFile(path.join(dir, 'data.db'));
    guard.repairFile(path.join(dir, 'data.db'));
    guard.writeSecretFile(path.join(dir, 'master.key'), 'k');
    guard.repairFile(path.join(dir, 'master.key'));
    expect(calls.filter((c) => !c.startsWith('create:.'))).toEqual(['create:data.db', 'protect:data.db', 'protect:master.key']);
  });

  it('appendSecretFile: 削除されて無くなったら保護付きで作り直し、別のファイルに置き換えられたら保護し直す', () => {
    const target = path.join(dir, 'update.log');
    const calls: string[] = [];
    const guard = make(fakeRun(calls));
    guard.appendSecretFile(target, 'a\n');
    guard.appendSecretFile(target, 'b\n');
    expect(calls).toEqual(['create:update.log']);

    fs.rmSync(target);
    guard.appendSecretFile(target, 'c\n');
    expect(calls).toEqual(['create:update.log', 'create:update.log']);
    expect(fs.readFileSync(target, 'utf-8')).toBe('c\n');

    // 別のファイルが同じ名前になった（rename で置き換え）: 実体が違うので保護し直す
    const other = path.join(dir, 'other');
    fs.writeFileSync(other, 'x\n');
    fs.renameSync(other, target);
    guard.appendSecretFile(target, 'd\n');
    expect(calls).toEqual(['create:update.log', 'create:update.log', 'protect:update.log']);
    expect(fs.readFileSync(target, 'utf-8')).toBe('x\nd\n');
  });

  it('appendSecretFile: 追記は既存のファイルを開く形で、確かめた後に消されても作り直さない', () => {
    const target = path.join(dir, 'update.log');
    const guard = make(fakeRun());
    guard.appendSecretFile(target, 'a\n');
    // 実体の確認と書き込みの間の削除は、次のように ENOENT になる（保護の無いファイルが作られない）
    const fdOpen = (): number => fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_APPEND);
    fs.rmSync(target);
    expect(fdOpen).toThrow();
    expect(fs.existsSync(target)).toBe(false);
  });
});

function icaclsOutput(target: string): string {
  return execFileSync('icacls', [target], { encoding: 'utf8' });
}

describe.skipIf(process.platform !== 'win32')('WindowsSecretFileGuard（実際の ACL）', () => {
  const powershellPath = process.platform === 'win32' ? resolveWindowsPowerShellPath(process.env) : '';
  const guard = new WindowsSecretFileGuard({ powershellPath, env: process.env });
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-wguard-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('緩い ACL（Users / Everyone の明示的な許可）を inspect が検出する', () => {
    const file = path.join(dir, 'loose');
    fs.writeFileSync(file, 'x');
    execFileSync('icacls', [file, '/grant', '*S-1-5-32-545:R', '/grant', '*S-1-1-0:R']);
    expect(guard.inspect(file, 'file').ok).toBe(false);
  });

  it('protectFile は既存の明示的な許可（Users / Everyone）も継承も除き、所有者を含めて現在のユーザーだけにする', () => {
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

  it('自分が所有者のファイルは、DACL だけが緩くても所有者を変えずに直せる', () => {
    const file = path.join(dir, 'self-owned');
    guard.writeSecretFile(file, 'x');
    execFileSync('icacls', [file, '/grant', '*S-1-1-0:R']);
    guard.protectFile(file);
    expect(guard.inspect(file, 'file')).toEqual({ ok: true });
  });

  it('所有者が現在のユーザー以外のファイルを inspect が違反とし、protectFile が直す（所有権を渡せる管理者権限があるときだけ）', () => {
    const file = path.join(dir, 'owned');
    fs.writeFileSync(file, 'x');
    try {
      execFileSync('icacls', [file, '/setowner', '*S-1-5-32-544'], { stdio: 'pipe' });
    } catch {
      return; // 権限が無い通常のユーザー: この準備ができないので、自分が所有者のケースで確かめる
    }
    const before = guard.inspect(file, 'file');
    expect(before.ok).toBe(false);
    if (!before.ok) expect(before.summary).toContain('所有者');
    guard.protectFile(file);
    expect(guard.inspect(file, 'file')).toEqual({ ok: true });
  });

  it('一時ファイルは作成の直後（中身を書く前）から、現在のユーザー以外の主体も他の所有者も持たない', () => {
    const real = createPowerShellRunner(powershellPath, process.env);
    const atCreation: unknown[] = [];
    const observing = new WindowsSecretFileGuard({
      powershellPath,
      env: process.env,
      run: (script, p) => {
        const out = real(script, p);
        if (script.includes('CreateNew')) atCreation.push(guard.inspect(p, 'file'));
        return out;
      },
    });
    const file = path.join(dir, 'master.key');
    observing.writeSecretFile(file, 'SECRET');
    expect(atCreation).toEqual([{ ok: true }]);
    expect(fs.readFileSync(file, 'utf-8')).toBe('SECRET');
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

  it('ensureProtectedDir の保護は、中に作ったファイルとディレクトリに他の主体を継承させない', () => {
    const data = path.join(dir, 'data');
    guard.ensureProtectedDir(data);
    expect(guard.inspect(data, 'dir')).toEqual({ ok: true });

    const child = path.join(data, 'data.db');
    fs.writeFileSync(child, 'x');
    fs.mkdirSync(path.join(data, 'browser-profile'));
    fs.writeFileSync(path.join(data, 'browser-profile', 'Cookies'), 'x');
    for (const p of [child, path.join(data, 'browser-profile', 'Cookies')]) {
      const out = icaclsOutput(p);
      expect(out).not.toMatch(/Everyone|BUILTIN\\Users|SYSTEM|Administrators/i);
    }
  });

  it('方針どおりのディレクトリには書き込まない（2 回目の ensureProtectedDir で ACL が変わらず、継承の伝播も起きない）', () => {
    const data = path.join(dir, 'data');
    guard.ensureProtectedDir(data);
    const child = path.join(data, 'browser-profile');
    fs.mkdirSync(child);
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(child, `f${i}`), 'x');
    guard.protectFile(child);
    const ctimeOf = (p: string): number => fs.statSync(p).ctimeMs;
    const before = [data, child, path.join(child, 'f0')].map(ctimeOf);
    guard.ensureProtectedDir(data);
    expect([data, child, path.join(child, 'f0')].map(ctimeOf)).toEqual(before);

    // 対照: 緩めれば直す（ACL が書き換わる）
    execFileSync('icacls', [data, '/grant', '*S-1-1-0:(OI)(CI)R']);
    guard.ensureProtectedDir(data);
    expect(guard.inspect(data, 'dir')).toEqual({ ok: true });
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

  it('appendSecretFile は緩い既存ファイルを、最初の追記の前に保護する', () => {
    const file = path.join(dir, 'update.log');
    fs.writeFileSync(file, 'old\n');
    execFileSync('icacls', [file, '/grant', '*S-1-1-0:R']);
    const fresh = new WindowsSecretFileGuard({ powershellPath, env: process.env });
    fresh.appendSecretFile(file, 'new\n');
    expect(fs.readFileSync(file, 'utf-8')).toBe('old\nnew\n');
    expect(guard.inspect(file, 'file')).toEqual({ ok: true });
  });

  it('appendSecretFile: 同名の緩いファイルに置き換えられたら、次の追記の前に保護し直す', () => {
    const file = path.join(dir, 'update.log');
    guard.appendSecretFile(file, 'a\n');
    const other = path.join(dir, 'other');
    fs.writeFileSync(other, 'x\n');
    execFileSync('icacls', [other, '/grant', '*S-1-1-0:R']);
    fs.renameSync(other, file);
    expect(guard.inspect(file, 'file').ok).toBe(false);
    guard.appendSecretFile(file, 'b\n');
    expect(guard.inspect(file, 'file')).toEqual({ ok: true });
    expect(fs.readFileSync(file, 'utf-8')).toBe('x\nb\n');
  });

  it('writeSecretFile の後でも、緩められたファイルは repairFile が毎回直す', () => {
    const file = path.join(dir, 'master.key');
    guard.writeSecretFile(file, 'k');
    execFileSync('icacls', [file, '/grant', '*S-1-1-0:R']);
    guard.repairFile(file);
    expect(guard.inspect(file, 'file')).toEqual({ ok: true });
  });

  it('repairFile は緩いファイルを直し、無いファイルは無視する', () => {
    const file = path.join(dir, 'ui-token');
    fs.writeFileSync(file, 'x');
    guard.repairFile(file);
    expect(guard.inspect(file, 'file')).toEqual({ ok: true });
    expect(() => guard.repairFile(path.join(dir, 'missing'))).not.toThrow();
  });

  it('緩い親ディレクトリに新しい DB を開いても、DB と -wal / -shm は書き込み後も現在のユーザーだけ', () => {
    const dbPath = path.join(dir, 'data.db');
    const db = openDatabase(dbPath, { secretFileGuard: new WindowsSecretFileGuard({ powershellPath, env: process.env }) });
    try {
      db.exec('CREATE TABLE IF NOT EXISTS probe (v TEXT); INSERT INTO probe VALUES (\'x\');');
      for (const suffix of ['', '-wal', '-shm']) {
        expect(fs.existsSync(`${dbPath}${suffix}`)).toBe(true);
        expect(guard.inspect(`${dbPath}${suffix}`, 'file')).toEqual({ ok: true });
      }
    } finally {
      db.close();
    }
  });
});
