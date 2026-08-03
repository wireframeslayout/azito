import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SidekickPackageLoader } from './SidekickPackageLoader';
import { SidekickPackageService } from './SidekickPackageService';

function writePackage(rootDir: string, name: string, phase = 'planning', isDefault = false): void {
  const dir = path.join(rootDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} description\nphase: ${phase}\nisDefault: ${isDefault}\n---\n${name} body`,
  );
}

describe('SidekickPackageService', () => {
  let builtinDir: string;
  let userDir: string;
  let loader: SidekickPackageLoader;
  let service: SidekickPackageService;

  beforeEach(() => {
    builtinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekicks-svc-builtin-'));
    userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekicks-svc-user-'));
    loader = new SidekickPackageLoader(builtinDir, userDir);
    service = new SidekickPackageService(loader, userDir);
  });

  afterEach(() => {
    fs.rmSync(builtinDir, { recursive: true, force: true });
    fs.rmSync(userDir, { recursive: true, force: true });
  });

  describe('list', () => {
    it('does not include the body field', () => {
      writePackage(builtinDir, 'planning-default');
      const list = service.list();
      expect(list[0]).not.toHaveProperty('body');
    });
  });

  describe('create', () => {
    it('scaffolds a new package into the user layer', () => {
      service.create({ name: 'my-pkg', description: 'desc', phase: 'standalone' });
      expect(fs.existsSync(path.join(userDir, 'my-pkg', 'SKILL.md'))).toBe(true);
      const pkg = service.getDetail('my-pkg');
      expect(pkg).toMatchObject({ name: 'my-pkg', description: 'desc', tags: [], layer: 'user' });
    });

    it('writes scripts with 0o755 permissions under scripts/', () => {
      service.create({
        name: 'my-pkg',
        description: 'd',
        phase: 'standalone',
        scripts: [{ filename: 'run.sh', content: '#!/bin/bash\necho hi\n' }],
      });
      const scriptPath = path.join(userDir, 'my-pkg', 'scripts', 'run.sh');
      expect(fs.existsSync(scriptPath)).toBe(true);
      const mode = fs.statSync(scriptPath).mode & 0o777;
      expect(mode).toBe(0o755);
    });

    it('rejects an invalid name', () => {
      expect(() => service.create({ name: '../evil', description: 'd', phase: 'standalone' })).toThrow('Invalid sidekick name');
      expect(fs.existsSync(path.join(userDir, '..', 'evil'))).toBe(false);
    });

    it('rejects a name starting with an uppercase letter', () => {
      expect(() => service.create({ name: 'Foo', description: 'd', phase: 'standalone' })).toThrow('Invalid sidekick name');
    });

    it('rejects an invalid phase', () => {
      expect(() => service.create({ name: 'foo', description: 'd', phase: 'bogus' as never })).toThrow('Invalid phase');
    });

    it('rejects a path-traversal script filename', () => {
      expect(() =>
        service.create({
          name: 'foo',
          description: 'd',
          phase: 'standalone',
          scripts: [{ filename: '../../evil.sh', content: 'x' }],
        }),
      ).toThrow('Invalid script filename');
    });

    it('rejects creating a package that already exists', () => {
      service.create({ name: 'dup', description: 'd', phase: 'standalone' });
      expect(() => service.create({ name: 'dup', description: 'd2', phase: 'standalone' })).toThrow('already exists');
    });

    it('scaffolds a package using the tags field directly', () => {
      service.create({ name: 'tagged-pkg', description: 'd', tags: ['implementing', 'reviewing'] });
      const pkg = service.getDetail('tagged-pkg');
      expect(pkg?.tags).toEqual(['implementing', 'reviewing']);
    });

    it('defaults to tags: [] when neither tags nor phase is given', () => {
      service.create({ name: 'untagged-pkg', description: 'd' });
      expect(service.getDetail('untagged-pkg')?.tags).toEqual([]);
    });

    it('rejects an invalid tag format', () => {
      expect(() => service.create({ name: 'foo', description: 'd', tags: ['Invalid_Tag'] })).toThrow('Invalid tag');
    });

    it('rejects isDefault: true with no phase tag', () => {
      expect(() => service.create({ name: 'foo', description: 'd', tags: ['issue'], isDefault: true }))
        .toThrow('requires at least one phase tag');
    });

    it('allows isDefault: true when at least one tag is a phase tag', () => {
      service.create({ name: 'foo', description: 'd', tags: ['implementing', 'issue'], isDefault: true });
      expect(service.getDetail('foo')?.isDefault).toBe(true);
    });

    it('is atomic: an invalid script filename leaves no partial package or temp dir behind', () => {
      expect(() =>
        service.create({
          name: 'partial',
          description: 'd',
          phase: 'standalone',
          scripts: [
            { filename: 'ok.sh', content: 'x' },
            { filename: '../../evil.sh', content: 'x' },
          ],
        }),
      ).toThrow('Invalid script filename');

      expect(fs.existsSync(path.join(userDir, 'partial'))).toBe(false);
      const leftovers = fs.readdirSync(userDir).filter((e) => e.startsWith('.tmp-'));
      expect(leftovers).toEqual([]);
      expect(service.getDetail('partial')).toBeNull();
    });
  });

  describe('update', () => {
    it('updates an existing user-layer package directly', () => {
      service.create({ name: 'my-pkg', description: 'old', phase: 'standalone' });
      service.update('my-pkg', { description: 'new' });
      expect(service.getDetail('my-pkg')?.description).toBe('new');
    });

    it('copy-on-write: updating a builtin-only package copies it into the user layer first', () => {
      writePackage(builtinDir, 'planning-default');
      service.update('planning-default', { description: 'edited' });

      expect(fs.existsSync(path.join(userDir, 'planning-default', 'SKILL.md'))).toBe(true);
      const pkg = service.getDetail('planning-default');
      expect(pkg?.layer).toBe('user');
      expect(pkg?.description).toBe('edited');
      // Builtin original is untouched
      const builtinRaw = fs.readFileSync(path.join(builtinDir, 'planning-default', 'SKILL.md'), 'utf-8');
      expect(builtinRaw).toContain('planning-default description');
    });

    it('copy-on-write preserves scripts/ from the builtin package', () => {
      writePackage(builtinDir, 'pushing-default', 'pushing');
      fs.mkdirSync(path.join(builtinDir, 'pushing-default', 'scripts'));
      fs.writeFileSync(path.join(builtinDir, 'pushing-default', 'scripts', 'push.sh'), '#!/bin/bash\n');

      service.update('pushing-default', { description: 'edited' });

      expect(fs.existsSync(path.join(userDir, 'pushing-default', 'scripts', 'push.sh'))).toBe(true);
    });

    it('throws for an unknown package', () => {
      expect(() => service.update('does-not-exist', { description: 'x' })).toThrow('not found');
    });

    it('updates tags directly', () => {
      service.create({ name: 'my-pkg', description: 'd', tags: ['implementing'] });
      service.update('my-pkg', { tags: ['reviewing', 'testing'] });
      expect(service.getDetail('my-pkg')?.tags).toEqual(['reviewing', 'testing']);
    });

    it('preserves existing tags when tags/phase are omitted from the update', () => {
      service.create({ name: 'my-pkg', description: 'd', tags: ['implementing'] });
      service.update('my-pkg', { description: 'new' });
      expect(service.getDetail('my-pkg')?.tags).toEqual(['implementing']);
    });

    it('accepts a legacy phase field and normalizes it to tags', () => {
      service.create({ name: 'my-pkg', description: 'd', tags: ['implementing'] });
      service.update('my-pkg', { phase: 'pushing' });
      expect(service.getDetail('my-pkg')?.tags).toEqual(['pushing']);
    });

    it('rejects setting isDefault: true when the merged tags have no phase tag', () => {
      service.create({ name: 'my-pkg', description: 'd', tags: ['issue'] });
      expect(() => service.update('my-pkg', { isDefault: true })).toThrow('requires at least one phase tag');
    });

    it('writes new scripts with 0o755 permissions under scripts/', () => {
      service.create({ name: 'my-pkg', description: 'd', phase: 'standalone' });
      service.update('my-pkg', { scripts: [{ filename: 'run.sh', content: '#!/bin/bash\necho hi\n' }] });

      const scriptPath = path.join(userDir, 'my-pkg', 'scripts', 'run.sh');
      expect(fs.existsSync(scriptPath)).toBe(true);
      const mode = fs.statSync(scriptPath).mode & 0o777;
      expect(mode).toBe(0o755);
    });

    it('upserts scripts without deleting existing ones not mentioned in the update', () => {
      service.create({
        name: 'my-pkg',
        description: 'd',
        phase: 'standalone',
        scripts: [{ filename: 'a.sh', content: 'old-a' }],
      });
      service.update('my-pkg', { scripts: [{ filename: 'b.sh', content: 'new-b' }] });

      expect(fs.readFileSync(path.join(userDir, 'my-pkg', 'scripts', 'a.sh'), 'utf-8')).toBe('old-a');
      expect(fs.readFileSync(path.join(userDir, 'my-pkg', 'scripts', 'b.sh'), 'utf-8')).toBe('new-b');
    });

    it('overwrites the content of an existing script with the same filename', () => {
      service.create({
        name: 'my-pkg',
        description: 'd',
        phase: 'standalone',
        scripts: [{ filename: 'a.sh', content: 'old' }],
      });
      service.update('my-pkg', { scripts: [{ filename: 'a.sh', content: 'new' }] });

      expect(fs.readFileSync(path.join(userDir, 'my-pkg', 'scripts', 'a.sh'), 'utf-8')).toBe('new');
    });

    it('copy-on-write: updating a builtin package with new scripts copies the builtin scripts/ then adds the new one', () => {
      writePackage(builtinDir, 'pushing-default', 'pushing');
      fs.mkdirSync(path.join(builtinDir, 'pushing-default', 'scripts'));
      fs.writeFileSync(path.join(builtinDir, 'pushing-default', 'scripts', 'push.sh'), '#!/bin/bash\n');

      service.update('pushing-default', { scripts: [{ filename: 'extra.sh', content: 'echo extra' }] });

      expect(fs.existsSync(path.join(userDir, 'pushing-default', 'scripts', 'push.sh'))).toBe(true);
      expect(fs.readFileSync(path.join(userDir, 'pushing-default', 'scripts', 'extra.sh'), 'utf-8')).toBe('echo extra');
    });

    it('rejects a path-traversal script filename and leaves the package untouched', () => {
      service.create({ name: 'my-pkg', description: 'old', phase: 'standalone' });
      expect(() =>
        service.update('my-pkg', { description: 'new', scripts: [{ filename: '../../evil.sh', content: 'x' }] }),
      ).toThrow('Invalid script filename');

      expect(service.getDetail('my-pkg')?.description).toBe('old');
      expect(fs.existsSync(path.join(userDir, 'my-pkg', 'scripts'))).toBe(false);
    });

    it('refuses to write through a symlinked scripts/ directory (link target untouched)', () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekicks-outside-'));
      try {
        service.create({ name: 'my-pkg', description: 'old', phase: 'standalone' });
        const realScripts = path.join(outside, 'scripts');
        fs.mkdirSync(realScripts);
        fs.symlinkSync(realScripts, path.join(userDir, 'my-pkg', 'scripts'));

        expect(() =>
          service.update('my-pkg', { scripts: [{ filename: 'evil.sh', content: 'pwned' }] }),
        ).toThrow('symlink');

        // リンク先には何も書き込まれていない
        expect(fs.readdirSync(realScripts)).toEqual([]);
        // 既存パッケージも無傷（symlink のまま、description も変わらない）
        expect(fs.lstatSync(path.join(userDir, 'my-pkg', 'scripts')).isSymbolicLink()).toBe(true);
        expect(service.getDetail('my-pkg')?.description).toBe('old');
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('refuses to write through a symlinked script file (link target content untouched)', () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekicks-outside-'));
      try {
        service.create({
          name: 'my-pkg',
          description: 'old',
          phase: 'standalone',
          scripts: [{ filename: 'run.sh', content: 'legit' }],
        });
        const target = path.join(outside, 'target.sh');
        fs.writeFileSync(target, 'original target');
        const linked = path.join(userDir, 'my-pkg', 'scripts', 'run.sh');
        fs.rmSync(linked);
        fs.symlinkSync(target, linked);

        expect(() =>
          service.update('my-pkg', { description: 'new', scripts: [{ filename: 'run.sh', content: 'pwned' }] }),
        ).toThrow('symlink');

        // リンク先の内容は書き換えられていない
        expect(fs.readFileSync(target, 'utf-8')).toBe('original target');
        // 既存パッケージも無傷（途中失敗が SKILL.md だけ更新した状態を残さない）
        expect(service.getDetail('my-pkg')?.description).toBe('old');
        expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
        // 一時ディレクトリが残っていない
        const leftovers = fs.readdirSync(userDir).filter((e) => e.startsWith('.tmp-'));
        expect(leftovers).toEqual([]);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('is atomic for builtins: a failed copy-on-write update leaves no user-layer copy behind', () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekicks-outside-'));
      try {
        writePackage(builtinDir, 'planning-default');
        // ビルトイン内の scripts/ を symlink にして scripts 書き込み段階で失敗させる
        const realScripts = path.join(outside, 'scripts');
        fs.mkdirSync(realScripts);
        fs.symlinkSync(realScripts, path.join(builtinDir, 'planning-default', 'scripts'));

        expect(() =>
          service.update('planning-default', { description: 'edited', scripts: [{ filename: 'x.sh', content: 'x' }] }),
        ).toThrow('symlink');

        // ユーザー層に中途半端なコピーが作られていない（copy-on-write が発生していない）
        expect(fs.existsSync(path.join(userDir, 'planning-default'))).toBe(false);
        expect(service.getDetail('planning-default')?.layer).toBe('builtin');
        const leftovers = fs.readdirSync(userDir).filter((e) => e.startsWith('.tmp-'));
        expect(leftovers).toEqual([]);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  describe('remove', () => {
    it('deletes a user-layer-only package entirely', () => {
      service.create({ name: 'user-only', description: 'd', phase: 'standalone' });
      service.remove('user-only');
      expect(service.getDetail('user-only')).toBeNull();
    });

    it('reverts to builtin when deleting a user override', () => {
      writePackage(builtinDir, 'planning-default');
      service.update('planning-default', { description: 'edited' });
      expect(service.getDetail('planning-default')?.layer).toBe('user');

      service.remove('planning-default');

      const pkg = service.getDetail('planning-default');
      expect(pkg?.layer).toBe('builtin');
      expect(pkg?.description).toBe('planning-default description');
    });

    it('rejects deleting a builtin-only package (400-level error)', () => {
      writePackage(builtinDir, 'planning-default');
      expect(() => service.remove('planning-default')).toThrow('only exists in the builtin layer');
    });

    it('throws for an unknown package', () => {
      expect(() => service.remove('does-not-exist')).toThrow('not found');
    });
  });

  describe('symlink safety', () => {
    it('refuses to update through a symlinked user package dir (does not touch the target)', () => {
      // userDir 外に実体を置き、userDir/<name> をそれへの symlink にする
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekicks-outside-'));
      try {
        const realPkg = path.join(outside, 'linked-pkg');
        fs.mkdirSync(realPkg);
        fs.writeFileSync(
          path.join(realPkg, 'SKILL.md'),
          '---\nname: linked-pkg\ndescription: outside\nphase: standalone\nisDefault: false\n---\nbody',
        );
        fs.symlinkSync(realPkg, path.join(userDir, 'linked-pkg'));

        // symlink はローダーの一覧に載らない（readdir withFileTypes の isDirectory() が false）ため
        // findByName は null → "not found"。仮に将来一覧に載っても resolveUserPackageDir が拒否する。
        expect(() => service.update('linked-pkg', { description: 'x' })).toThrow(/not found|symlink/);
        // 実体の SKILL.md は書き換えられていない
        expect(fs.readFileSync(path.join(realPkg, 'SKILL.md'), 'utf-8')).toContain('description: outside');
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('refuses to remove through a symlinked user package dir (target survives)', () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekicks-outside-'));
      try {
        const realPkg = path.join(outside, 'linked-pkg');
        fs.mkdirSync(realPkg);
        fs.writeFileSync(path.join(realPkg, 'precious.txt'), 'keep me');
        fs.symlinkSync(realPkg, path.join(userDir, 'linked-pkg'));

        expect(() => service.remove('linked-pkg')).toThrow(/not found|symlink/);
        expect(fs.existsSync(path.join(realPkg, 'precious.txt'))).toBe(true);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });

    it('refuses to create when the target path is already a symlink', () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sidekicks-outside-'));
      try {
        const realTarget = path.join(outside, 'target');
        fs.mkdirSync(realTarget);
        fs.symlinkSync(realTarget, path.join(userDir, 'sneaky'));

        expect(() => service.create({ name: 'sneaky', description: 'd', phase: 'standalone' })).toThrow('symlink');
        expect(fs.existsSync(path.join(realTarget, 'SKILL.md'))).toBe(false);
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  });
});
