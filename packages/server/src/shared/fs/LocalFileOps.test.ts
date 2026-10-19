import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import * as fs from 'fs';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { FileOpsError, type FileOpsErrorCode } from './fileOps';
import { LocalFileOps, localFileOpsHost } from './LocalFileOps';

const isWindows = process.platform === 'win32';
const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

let dir: string;
let home: string;
let ops: LocalFileOps;

async function codeOf(run: Promise<unknown>): Promise<FileOpsErrorCode> {
  try {
    await run;
  } catch (err) {
    if (err instanceof FileOpsError) return err.code;
    throw err;
  }
  throw new Error('expected a FileOpsError');
}

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'azito-fileops-')));
  home = path.join(dir, 'home');
  mkdirSync(home);
  ops = new LocalFileOps(localFileOpsHost({ platform: process.platform, homeDir: home }));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('LocalFileOps.list', () => {
  it('lists entries with their kind and, for files, the size and mtime', async () => {
    writeFileSync(path.join(dir, 'a.txt'), 'hello');
    mkdirSync(path.join(dir, 'sub'));
    writeFileSync(path.join(dir, '.hidden'), '');
    const entries = (await ops.list(dir)).sort((a, b) => a.name.localeCompare(b.name));
    expect(entries).toEqual([
      { name: '.hidden', kind: 'file', size: 0, mtimeMs: statSync(path.join(dir, '.hidden')).mtimeMs },
      { name: 'a.txt', kind: 'file', size: 5, mtimeMs: statSync(path.join(dir, 'a.txt')).mtimeMs },
      { name: 'home', kind: 'directory' },
      { name: 'sub', kind: 'directory' },
    ]);
  });

  it.skipIf(isWindows)('reports a symbolic link as one, sized by what it points at, and a dangling one without a size', async () => {
    writeFileSync(path.join(dir, 'target.txt'), 'abc');
    symlinkSync('target.txt', path.join(dir, 'link'));
    symlinkSync('missing', path.join(dir, 'dangling'));
    const byName = Object.fromEntries((await ops.list(dir)).map((e) => [e.name, e]));
    expect(byName.link).toEqual({ name: 'link', kind: 'symlink', size: 3, mtimeMs: statSync(path.join(dir, 'target.txt')).mtimeMs });
    expect(byName.dangling).toEqual({ name: 'dangling', kind: 'symlink' });
  });

  it('is NOT_FOUND for a missing directory and NOT_A_DIRECTORY for a file', async () => {
    writeFileSync(path.join(dir, 'f'), '');
    expect(await codeOf(ops.list(path.join(dir, 'missing')))).toBe('NOT_FOUND');
    expect(await codeOf(ops.list(path.join(dir, 'f')))).toBe('NOT_A_DIRECTORY');
  });
});

describe('LocalFileOps.stat', () => {
  it('describes a file and a directory, and is null for nothing', async () => {
    writeFileSync(path.join(dir, 'f.txt'), 'four');
    const file = await ops.stat(path.join(dir, 'f.txt'));
    expect(file).toMatchObject({ kind: 'file', size: 4 });
    expect(file?.mtimeMs).toBe(statSync(path.join(dir, 'f.txt')).mtimeMs);
    expect((await ops.stat(dir))?.kind).toBe('directory');
    expect(await ops.stat(path.join(dir, 'nope'))).toBeNull();
  });

  it.skipIf(isWindows)('follows links unless asked not to', async () => {
    writeFileSync(path.join(dir, 'f.txt'), 'four');
    symlinkSync('f.txt', path.join(dir, 'link'));
    expect((await ops.stat(path.join(dir, 'link')))?.kind).toBe('file');
    expect((await ops.stat(path.join(dir, 'link'), { followLinks: false }))?.kind).toBe('symlink');
    symlinkSync('missing', path.join(dir, 'dangling'));
    expect(await ops.stat(path.join(dir, 'dangling'))).toBeNull();
    expect((await ops.stat(path.join(dir, 'dangling'), { followLinks: false }))?.kind).toBe('symlink');
  });
});

describe('LocalFileOps.read', () => {
  it('returns the exact bytes with the stat', async () => {
    const bytes = Buffer.from([0x61, 0x0a, 0x00, 0xff, 0x62, 0x0a]);
    writeFileSync(path.join(dir, 'b.bin'), bytes);
    const { data, stat } = await ops.read(path.join(dir, 'b.bin'));
    expect(data.equals(bytes)).toBe(true);
    expect(stat.size).toBe(6);
  });

  it('refuses a file over maxBytes without reading it, reporting its size', async () => {
    writeFileSync(path.join(dir, 'big'), 'x'.repeat(100));
    try {
      await ops.read(path.join(dir, 'big'), { maxBytes: 10 });
      throw new Error('should have failed');
    } catch (err) {
      expect(err).toBeInstanceOf(FileOpsError);
      expect((err as FileOpsError).code).toBe('TOO_LARGE');
      expect((err as FileOpsError).details.size).toBe(100);
    }
    expect((await ops.read(path.join(dir, 'big'), { maxBytes: 100 })).data.length).toBe(100);
  });

  it('reads only the first headBytes of a file, however large, and all of a shorter one', async () => {
    writeFileSync(path.join(dir, 'rollout'), 'first line\nsecond line\n');
    const head = await ops.read(path.join(dir, 'rollout'), { headBytes: 10 });
    expect(head.data.toString()).toBe('first line');
    expect(head.stat.size).toBe(23);
    expect((await ops.read(path.join(dir, 'rollout'), { headBytes: 1000 })).data.toString()).toBe('first line\nsecond line\n');
    writeFileSync(path.join(dir, 'empty'), '');
    expect((await ops.read(path.join(dir, 'empty'), { headBytes: 10 })).data.length).toBe(0);
  });

  it('is NOT_FOUND for a missing path and NOT_A_FILE for a directory', async () => {
    expect(await codeOf(ops.read(path.join(dir, 'missing')))).toBe('NOT_FOUND');
    expect(await codeOf(ops.read(dir))).toBe('NOT_A_FILE');
  });
});

describe('LocalFileOps.write', () => {
  it('creates a missing file and returns its mtime and the hash of what was written', async () => {
    const target = path.join(dir, 'new.txt');
    const result = await ops.write(target, Buffer.from('hello\n'));
    expect(readFileSync(target, 'utf8')).toBe('hello\n');
    expect(result).toEqual({ mtimeMs: statSync(target).mtimeMs, sha256: sha256('hello\n') });
  });

  it('replaces the content and leaves no staging file behind', async () => {
    const target = path.join(dir, 'f.txt');
    writeFileSync(target, 'old');
    await ops.write(target, Buffer.from('new'));
    expect(readFileSync(target, 'utf8')).toBe('new');
    expect(readdirSync(dir).filter((n) => n.includes('azito-tmp'))).toEqual([]);
  });

  it('writes bytes as they are (no text conversion)', async () => {
    const target = path.join(dir, 'b.bin');
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x0d, 0x0a]);
    await ops.write(target, bytes);
    expect(readFileSync(target).equals(bytes)).toBe(true);
  });

  it.skipIf(isWindows)('keeps the permission bits of an existing file', async () => {
    const target = path.join(dir, 'script.sh');
    writeFileSync(target, '#!/bin/sh\n');
    chmodSync(target, 0o750);
    await ops.write(target, Buffer.from('#!/bin/sh\necho hi\n'));
    expect(statSync(target).mode & 0o777).toBe(0o750);
  });

  it.skipIf(isWindows)('refuses to write through a symbolic link and leaves its target alone', async () => {
    writeFileSync(path.join(dir, 'target.txt'), 'original');
    symlinkSync('target.txt', path.join(dir, 'link'));
    expect(await codeOf(ops.write(path.join(dir, 'link'), Buffer.from('changed')))).toBe('SYMLINK_REFUSED');
    expect(readFileSync(path.join(dir, 'target.txt'), 'utf8')).toBe('original');
  });

  it('refuses a directory', async () => {
    expect(await codeOf(ops.write(dir, Buffer.from('x')))).toBe('NOT_A_FILE');
  });

  // root bypasses permission bits; Windows has no such bits to set
  it.skipIf(isWindows || process.getuid?.() === 0)('refuses to replace a file that may not be written, as opening it for writing always did', async () => {
    const target = path.join(dir, 'readonly.txt');
    writeFileSync(target, 'keep');
    chmodSync(target, 0o444);
    expect(await codeOf(ops.write(target, Buffer.from('changed')))).toBe('PERMISSION_DENIED');
    expect(readFileSync(target, 'utf8')).toBe('keep');
    expect(readdirSync(dir).filter((n) => n.includes('azito-tmp'))).toEqual([]);
  });

  it.skipIf(isWindows)('keeps the owner and group of an existing file (a write that cannot is refused, not done with another owner)', async () => {
    const target = path.join(dir, 'owned.txt');
    writeFileSync(target, 'v1');
    await ops.write(target, Buffer.from('v2'));
    const after = statSync(target);
    expect({ uid: after.uid, gid: after.gid }).toEqual({ uid: process.getuid!(), gid: process.getgid!() });
  });

  it('serializes lock-checked writes to the same file: of two writes expecting the same version only one lands', async () => {
    const target = path.join(dir, 'f.txt');
    writeFileSync(target, 'v1');
    const expect1 = { sha256: sha256('v1') };
    const results = await Promise.allSettled([ops.write(target, Buffer.from('A'), { expect: expect1 }), ops.write(target, Buffer.from('B'), { expect: expect1 })]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!.reason).toMatchObject({ code: 'CONFLICT' });
  });

  it.skipIf(!isWindows)('rewrites an existing file where it is on Windows, so that its ACL stays', async () => {
    const target = path.join(dir, 'acl.txt');
    writeFileSync(target, 'v1');
    const before = statSync(target).ino;
    await ops.write(target, Buffer.from('v2'));
    expect(statSync(target).ino).toBe(before);
    expect(readFileSync(target, 'utf8')).toBe('v2');
  });

  it('is NOT_FOUND when the parent directory is missing', async () => {
    expect(await codeOf(ops.write(path.join(dir, 'no', 'such', 'f.txt'), Buffer.from('x')))).toBe('NOT_FOUND');
  });

  describe('optimistic lock', () => {
    it('writes when the expected mtime and hash match', async () => {
      const target = path.join(dir, 'f.txt');
      writeFileSync(target, 'v1');
      await ops.write(target, Buffer.from('v2'), { expect: { mtimeMs: statSync(target).mtimeMs, sha256: sha256('v1') } });
      expect(readFileSync(target, 'utf8')).toBe('v2');
    });

    it('is a CONFLICT carrying the current mtime when the mtime differs, and writes nothing', async () => {
      const target = path.join(dir, 'f.txt');
      writeFileSync(target, 'v1');
      const mtimeMs = statSync(target).mtimeMs;
      try {
        await ops.write(target, Buffer.from('v2'), { expect: { mtimeMs: mtimeMs - 1 } });
        throw new Error('should have failed');
      } catch (err) {
        expect((err as FileOpsError).code).toBe('CONFLICT');
        expect((err as FileOpsError).details.currentMtimeMs).toBe(mtimeMs);
      }
      expect(readFileSync(target, 'utf8')).toBe('v1');
    });

    it('is a CONFLICT when the content differs even though the mtime matches (an edit within the same tick)', async () => {
      const target = path.join(dir, 'f.txt');
      writeFileSync(target, 'v1');
      const mtimeMs = statSync(target).mtimeMs;
      writeFileSync(target, 'v9');
      utimesSync(target, new Date(), new Date(mtimeMs));
      expect(await codeOf(ops.write(target, Buffer.from('v2'), { expect: { mtimeMs: statSync(target).mtimeMs, sha256: sha256('v1') } }))).toBe('CONFLICT');
      expect(readFileSync(target, 'utf8')).toBe('v9');
    });

    it('fails closed when the file is gone', async () => {
      try {
        await ops.write(path.join(dir, 'gone.txt'), Buffer.from('x'), { expect: { mtimeMs: 1 } });
        throw new Error('should have failed');
      } catch (err) {
        expect((err as FileOpsError).code).toBe('CONFLICT');
        expect((err as FileOpsError).details.currentMtimeMs).toBeNull();
      }
    });
  });
});

describe('LocalFileOps.create', () => {
  it('creates an empty file and a directory', async () => {
    expect(await ops.create(path.join(dir, 'f.txt'), 'file')).toEqual({ created: true });
    expect(await ops.create(path.join(dir, 'd'), 'directory')).toEqual({ created: true });
    expect(statSync(path.join(dir, 'f.txt')).size).toBe(0);
    expect(statSync(path.join(dir, 'd')).isDirectory()).toBe(true);
  });

  it('is ALREADY_EXISTS for an existing entry, and does not touch it', async () => {
    writeFileSync(path.join(dir, 'f.txt'), 'keep');
    expect(await codeOf(ops.create(path.join(dir, 'f.txt'), 'file'))).toBe('ALREADY_EXISTS');
    expect(await codeOf(ops.create(dir, 'directory'))).toBe('ALREADY_EXISTS');
    expect(readFileSync(path.join(dir, 'f.txt'), 'utf8')).toBe('keep');
  });

  it('is NOT_FOUND without recursive when the parent is missing', async () => {
    expect(await codeOf(ops.create(path.join(dir, 'a', 'b'), 'directory'))).toBe('NOT_FOUND');
  });

  it('creates every missing level with recursive, and accepts an existing directory', async () => {
    const nested = path.join(dir, 'a', 'b', 'c');
    expect(await ops.create(nested, 'directory', { recursive: true })).toEqual({ created: true });
    expect(await ops.create(nested, 'directory', { recursive: true })).toEqual({ created: false });
  });

  it('refuses a recursive directory over a file', async () => {
    writeFileSync(path.join(dir, 'f'), '');
    expect(await codeOf(ops.create(path.join(dir, 'f'), 'directory', { recursive: true }))).toBe('ALREADY_EXISTS');
  });
});

describe('LocalFileOps.remove', () => {
  it('removes a file and a directory with its content', async () => {
    writeFileSync(path.join(dir, 'f.txt'), '');
    mkdirSync(path.join(dir, 'd', 'inner'), { recursive: true });
    writeFileSync(path.join(dir, 'd', 'inner', 'x'), '');
    await ops.remove(path.join(dir, 'f.txt'));
    await ops.remove(path.join(dir, 'd'));
    expect(readdirSync(dir)).toEqual(['home']);
  });

  it('is NOT_FOUND for a missing path', async () => {
    expect(await codeOf(ops.remove(path.join(dir, 'missing')))).toBe('NOT_FOUND');
  });

  it('refuses a path whose last element is "." or "..", and removes nothing', async () => {
    mkdirSync(path.join(dir, 'root', 'sub'), { recursive: true });
    writeFileSync(path.join(dir, 'sibling.txt'), '');
    for (const p of [`${dir}${path.sep}root${path.sep}..`, `${dir}${path.sep}root${path.sep}sub${path.sep}..${path.sep}..`, `${dir}${path.sep}root${path.sep}.`]) {
      expect(await codeOf(ops.remove(p)), p).toBe('INVALID_PATH');
    }
    expect(readdirSync(dir).sort()).toEqual(['home', 'root', 'sibling.txt']);
  });

  it.skipIf(isWindows)('removes a link itself, not what it points at', async () => {
    mkdirSync(path.join(dir, 'real'));
    writeFileSync(path.join(dir, 'real', 'keep'), '');
    symlinkSync('real', path.join(dir, 'link'));
    await ops.remove(path.join(dir, 'link'));
    expect(readdirSync(path.join(dir, 'real'))).toEqual(['keep']);
  });
});

describe('LocalFileOps.rename', () => {
  it('moves a file', async () => {
    writeFileSync(path.join(dir, 'a.txt'), 'x');
    await ops.rename(path.join(dir, 'a.txt'), path.join(dir, 'b.txt'));
    expect(readdirSync(dir).sort()).toEqual(['b.txt', 'home']);
  });

  it('is NOT_FOUND for a missing source and ALREADY_EXISTS for an existing destination, which stays as it was', async () => {
    writeFileSync(path.join(dir, 'a.txt'), 'a');
    writeFileSync(path.join(dir, 'b.txt'), 'b');
    expect(await codeOf(ops.rename(path.join(dir, 'missing'), path.join(dir, 'c')))).toBe('NOT_FOUND');
    expect(await codeOf(ops.rename(path.join(dir, 'a.txt'), path.join(dir, 'b.txt')))).toBe('ALREADY_EXISTS');
    expect(readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe('b');
  });
});

describe('LocalFileOps.rename races', () => {
  it('lets only one of two concurrent moves to the same name win, and keeps the loser\'s source', async () => {
    writeFileSync(path.join(dir, 'a'), 'A');
    writeFileSync(path.join(dir, 'b'), 'B');
    const results = await Promise.allSettled([ops.rename(path.join(dir, 'a'), path.join(dir, 'c')), ops.rename(path.join(dir, 'b'), path.join(dir, 'c'))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
    expect(loser.reason).toMatchObject({ code: 'ALREADY_EXISTS' });
    const winnerContent = readFileSync(path.join(dir, 'c'), 'utf8');
    expect(readdirSync(dir).sort()).toEqual(winnerContent === 'A' ? ['b', 'c', 'home'] : ['a', 'c', 'home']);
  });

  it.skipIf(isWindows)('moves a link as a link (not what it points at), a dangling one included', async () => {
    writeFileSync(path.join(dir, 'target.txt'), 'T');
    symlinkSync('target.txt', path.join(dir, 'l1'));
    symlinkSync('missing', path.join(dir, 'dangling'));
    await ops.rename(path.join(dir, 'l1'), path.join(dir, 'l2'));
    await ops.rename(path.join(dir, 'dangling'), path.join(dir, 'dangling2'));
    expect(lstatSync(path.join(dir, 'l2')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(path.join(dir, 'l2'))).toBe('target.txt');
    expect(lstatSync(path.join(dir, 'dangling2')).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(dir, 'l1'))).toBe(false);
    expect(readFileSync(path.join(dir, 'target.txt'), 'utf8')).toBe('T');
  });

  describe.skipIf(isWindows)('when the source cannot be unlinked after the link was made', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('removes the new name again and reports the failure, instead of reporting a move that left both names', async () => {
      writeFileSync(path.join(dir, 'a'), 'A');
      const real = fs.promises.unlink.bind(fs.promises);
      vi.spyOn(fs.promises, 'unlink').mockImplementation(async (p) => {
        if (String(p) === path.join(dir, 'a')) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        return real(p);
      });
      await expect(ops.rename(path.join(dir, 'a'), path.join(dir, 'b'))).rejects.toThrow(/EPERM/);
      expect(readdirSync(dir).sort()).toEqual(['a', 'home']);
      expect(readFileSync(path.join(dir, 'a'), 'utf8')).toBe('A');
    });

    it('carries both failures when the undo fails too', async () => {
      writeFileSync(path.join(dir, 'a'), 'A');
      vi.spyOn(fs.promises, 'unlink').mockRejectedValue(Object.assign(new Error('EIO'), { code: 'EIO' }));
      const err = await ops.rename(path.join(dir, 'a'), path.join(dir, 'b')).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AggregateError);
      expect((err as AggregateError).errors).toHaveLength(2);
    });
  });

  it.skipIf(isWindows)('treats a destination reached through another spelling of its directory as the same lock', async () => {
    mkdirSync(path.join(dir, 'real'));
    symlinkSync('real', path.join(dir, 'alias'));
    writeFileSync(path.join(dir, 'real', 'f.txt'), 'v1');
    const expectV1 = { sha256: sha256('v1') };
    const results = await Promise.allSettled([
      ops.write(path.join(dir, 'real', 'f.txt'), Buffer.from('A'), { expect: expectV1 }),
      ops.write(path.join(dir, 'alias', 'f.txt'), Buffer.from('B'), { expect: expectV1 }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it.skipIf(isWindows)('moves a directory, and refuses to move onto an existing name', async () => {
    mkdirSync(path.join(dir, 'd1'));
    mkdirSync(path.join(dir, 'd2'));
    await ops.rename(path.join(dir, 'd1'), path.join(dir, 'd3'));
    expect(await codeOf(ops.rename(path.join(dir, 'd3'), path.join(dir, 'd2')))).toBe('ALREADY_EXISTS');
  });
});

describe('LocalFileOps.realpath', () => {
  it.skipIf(isWindows)('resolves links to the real path', async () => {
    mkdirSync(path.join(dir, 'real'));
    symlinkSync('real', path.join(dir, 'link'));
    expect(await ops.realpath(path.join(dir, 'link'))).toBe(path.join(dir, 'real'));
  });

  it('reads a leading ~ as the home directory', async () => {
    mkdirSync(path.join(home, 'work'));
    expect(await ops.realpath('~')).toBe(home);
    expect(await ops.realpath('~/work')).toBe(path.join(home, 'work'));
  });

  it('is NOT_FOUND for a missing path', async () => {
    expect(await codeOf(ops.realpath(path.join(dir, 'missing')))).toBe('NOT_FOUND');
  });
});

describe('LocalFileOps input checks', () => {
  it('refuses an empty path and a NUL byte on every operation', async () => {
    expect(await codeOf(ops.stat(''))).toBe('INVALID_PATH');
    expect(await codeOf(ops.read(`${dir}\0x`))).toBe('INVALID_PATH');
    expect(await codeOf(ops.write(`${dir}\0x`, Buffer.alloc(0)))).toBe('INVALID_PATH');
    expect(await codeOf(ops.realpath(''))).toBe('INVALID_PATH');
  });
});

describe('localFileOpsHost', () => {
  it('keeps the home directory and narrows the platform', () => {
    expect(localFileOpsHost({ platform: 'linux', homeDir: '/h' })).toEqual({ platform: 'linux', homeDir: '/h' });
    expect(localFileOpsHost({ platform: 'win32', homeDir: 'C:\\h' })).toEqual({ platform: 'win32', homeDir: 'C:\\h' });
  });

  it('treats an OS AZITO has no profile for as POSIX', () => {
    expect(localFileOpsHost({ platform: 'freebsd', homeDir: '/h' }).platform).toBe('linux');
    expect(localFileOpsHost({ platform: 'darwin', homeDir: '/h' }).platform).toBe('darwin');
  });
});

describe('LocalFileOps.walk', () => {
  const options = { excludeNames: [] as string[], maxEntries: 1000, timeBudgetMs: 10_000 };

  function files(...names: string[]): void {
    for (const name of names) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), 'x');
    }
  }

  it('returns the regular files at any depth, level by level and by name, with their mtime', async () => {
    files('b.txt', 'a.txt', 'sub/z.txt', 'sub/deep/y.txt');

    const { entries, truncated } = await ops.walk(dir, options);

    expect(entries.map((e) => e.path)).toEqual(['a.txt', 'b.txt', 'sub/z.txt', 'sub/deep/y.txt']);
    expect(entries[0].mtimeMs).toBe(statSync(path.join(dir, 'a.txt')).mtimeMs);
    expect(truncated).toBe(false);
  });

  it('skips excluded names (globs, files and directories) at any depth, without entering them', async () => {
    files('keep.ts', 'node_modules/p/a.js', 'a/node_modules/b.js', 'a/skip.log', 'a/ok.ts');

    const { entries } = await ops.walk(dir, { ...options, excludeNames: ['node_modules', '*.log', 'home'] });

    expect(entries.map((e) => e.path)).toEqual(['keep.ts', 'a/ok.ts']);
  });

  it.skipIf(isWindows)('neither follows nor lists symbolic links', async () => {
    files('real/a.txt');
    symlinkSync(path.join(dir, 'real'), path.join(dir, 'dirlink'));
    symlinkSync(path.join(dir, 'real', 'a.txt'), path.join(dir, 'filelink'));

    expect((await ops.walk(dir, { ...options, excludeNames: ['home'] })).entries.map((e) => e.path)).toEqual(['real/a.txt']);
  });

  it('stops at maxEntries and says so, and honors maxDepth', async () => {
    files('a.txt', 'b.txt', 'c.txt', 'd/e.txt');

    const limited = await ops.walk(dir, { ...options, maxEntries: 2 });
    expect(limited.entries).toHaveLength(2);
    expect(limited.truncated).toBe(true);

    const shallow = await ops.walk(dir, { ...options, maxDepth: 0 });
    expect(shallow.entries.map((e) => e.path)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(shallow.truncated).toBe(false);
  });

  it('stops when the time budget is used up', async () => {
    files('a.txt', 'sub/b.txt');

    const late = await ops.walk(dir, { ...options, timeBudgetMs: -1 });

    expect(late.truncated).toBe(true);
    expect(late.entries).toEqual([]);
  });

  it('is NOT_FOUND for a missing root and NOT_A_DIRECTORY for a file', async () => {
    files('f.txt');
    expect(await codeOf(ops.walk(path.join(dir, 'missing'), options))).toBe('NOT_FOUND');
    expect(await codeOf(ops.walk(path.join(dir, 'f.txt'), options))).toBe('NOT_A_DIRECTORY');
  });
});

describe('LocalFileOps.replaceDirectory', () => {
  function tree(name: string, content: string): string {
    const full = path.join(dir, name);
    mkdirSync(full, { recursive: true });
    writeFileSync(path.join(full, 'f.txt'), content);
    return full;
  }
  const leftovers = (): string[] => readdirSync(dir).filter((n) => n.includes('azito-old'));

  it('puts the staging directory where the target was, and removes the old tree', async () => {
    const target = tree('target', 'old');
    const staging = tree('staging', 'new');

    await ops.replaceDirectory(staging, target);

    expect(readFileSync(path.join(target, 'f.txt'), 'utf8')).toBe('new');
    expect(existsSync(staging)).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('moves into a target that does not exist', async () => {
    const staging = tree('staging', 'new');

    await ops.replaceDirectory(staging, path.join(dir, 'target'));

    expect(readFileSync(path.join(dir, 'target', 'f.txt'), 'utf8')).toBe('new');
  });

  it('keeps the old tree when the staging directory is missing, or is not a directory', async () => {
    const target = tree('target', 'old');

    expect(await codeOf(ops.replaceDirectory(path.join(dir, 'missing'), target))).toBe('NOT_FOUND');
    writeFileSync(path.join(dir, 'file'), '');
    expect(await codeOf(ops.replaceDirectory(path.join(dir, 'file'), target))).toBe('NOT_A_DIRECTORY');

    expect(readFileSync(path.join(target, 'f.txt'), 'utf8')).toBe('old');
    expect(leftovers()).toEqual([]);
  });

  it('puts the old tree back when the staging directory cannot be moved in', async () => {
    const target = tree('target', 'old');
    const staging = tree('staging', 'new');
    const realRename = fs.promises.rename;
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === staging) throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
      return realRename(from, to);
    });

    try {
      await expect(ops.replaceDirectory(staging, target)).rejects.toThrow('EXDEV');
    } finally {
      spy.mockRestore();
    }

    expect(readFileSync(path.join(target, 'f.txt'), 'utf8')).toBe('old');
    expect(readFileSync(path.join(staging, 'f.txt'), 'utf8')).toBe('new');
    expect(leftovers()).toEqual([]);
  });
});

describe('LocalFileOps.stat withAge', () => {
  it('reports how long ago the entry was modified, by this host\'s clock, only when asked', async () => {
    writeFileSync(path.join(dir, 'f'), 'x');
    const old = (Date.now() - 10 * 60 * 1000) / 1000;
    utimesSync(path.join(dir, 'f'), old, old);

    const aged = await ops.stat(path.join(dir, 'f'), { withAge: true });

    expect(aged?.ageMs).toBeGreaterThan(9.9 * 60 * 1000);
    expect(aged?.ageMs).toBeLessThan(10.5 * 60 * 1000);
    expect((await ops.stat(path.join(dir, 'f')))?.ageMs).toBeUndefined();
  });
});
