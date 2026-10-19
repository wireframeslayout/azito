import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { FileOpsError, type FileOpsErrorCode } from './fileOps';
import { LocalFileOps, localFileOpsHostFromEnv, type LocalFileOpsHost } from './LocalFileOps';

const isWindows = process.platform === 'win32';
const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

let dir: string;
let home: string;
let ops: LocalFileOps;

function opsWith(overrides: Partial<LocalFileOpsHost> = {}): LocalFileOps {
  return new LocalFileOps({ ...localFileOpsHostFromEnv({ platform: process.platform, homeDir: home, tmpDir: dir }, process.env), ...overrides });
}

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
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'azito-fileops-')));
  home = path.join(dir, 'home');
  mkdirSync(home);
  ops = opsWith();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('LocalFileOps.list', () => {
  it('lists entries with their kind and, for files, the size', async () => {
    writeFileSync(path.join(dir, 'a.txt'), 'hello');
    mkdirSync(path.join(dir, 'sub'));
    writeFileSync(path.join(dir, '.hidden'), '');
    const entries = (await ops.list(dir)).sort((a, b) => a.name.localeCompare(b.name));
    expect(entries).toEqual([
      { name: '.hidden', kind: 'file', size: 0 },
      { name: 'a.txt', kind: 'file', size: 5 },
      { name: 'home', kind: 'directory' },
      { name: 'sub', kind: 'directory' },
    ]);
  });

  it.skipIf(isWindows)('reports a symbolic link as one, sized by what it points at, and a dangling one without a size', async () => {
    writeFileSync(path.join(dir, 'target.txt'), 'abc');
    symlinkSync('target.txt', path.join(dir, 'link'));
    symlinkSync('missing', path.join(dir, 'dangling'));
    const byName = Object.fromEntries((await ops.list(dir)).map((e) => [e.name, e]));
    expect(byName.link).toEqual({ name: 'link', kind: 'symlink', size: 3 });
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

describe('LocalFileOps.which', () => {
  const exe = isWindows ? 'azito-tool.cmd' : 'azito-tool';

  function installTool(into: string): string {
    mkdirSync(into, { recursive: true });
    const file = path.join(into, exe);
    writeFileSync(file, isWindows ? '@echo off\r\n' : '#!/bin/sh\n');
    chmodSync(file, 0o755);
    return file;
  }

  it('finds a command on the PATH, in PATH order', async () => {
    const first = installTool(path.join(dir, 'bin1'));
    installTool(path.join(dir, 'bin2'));
    const withPath = opsWith({ pathEnv: [path.join(dir, 'bin1'), path.join(dir, 'bin2')].join(path.delimiter), pathExt: '.COM;.EXE;.BAT;.CMD' });
    expect(await withPath.which('azito-tool')).toBe(first);
  });

  it('is null for a command that is on no PATH entry, and with no PATH at all', async () => {
    installTool(path.join(dir, 'bin'));
    expect(await opsWith({ pathEnv: path.join(dir, 'elsewhere'), pathExt: '.CMD' }).which('azito-tool')).toBeNull();
    expect(await opsWith({ pathEnv: undefined, pathExt: undefined }).which('azito-tool')).toBeNull();
  });

  it('checks a name with a directory as a path', async () => {
    const file = installTool(path.join(dir, 'bin'));
    expect(await opsWith({ pathEnv: '', pathExt: '.CMD' }).which(file)).toBe(file);
  });

  it.skipIf(isWindows)('ignores a file that is not executable', async () => {
    const file = installTool(path.join(dir, 'bin'));
    chmodSync(file, 0o644);
    expect(await opsWith({ pathEnv: path.join(dir, 'bin') }).which('azito-tool')).toBeNull();
  });

  it('ignores a directory with the name', async () => {
    mkdirSync(path.join(dir, 'bin', exe), { recursive: true });
    expect(await opsWith({ pathEnv: path.join(dir, 'bin'), pathExt: '.CMD' }).which('azito-tool')).toBeNull();
  });

  it.skipIf(!isWindows)('adds the extensions of PATHEXT on Windows, and accepts a name that already has one', async () => {
    const file = installTool(path.join(dir, 'bin'));
    const withPath = opsWith({ pathEnv: path.join(dir, 'bin'), pathExt: '.COM;.EXE;.BAT;.CMD' });
    expect(await withPath.which('azito-tool')).toBe(file);
    expect(await withPath.which('azito-tool.cmd')).toBe(file);
  });
});

describe('LocalFileOps.tmpPath', () => {
  it('names a path in the host temporary directory without creating it, different each time', async () => {
    const first = await ops.tmpPath('azito-test');
    const second = await ops.tmpPath('azito-test');
    expect(path.dirname(first)).toBe(dir);
    expect(path.basename(first)).toMatch(/^azito-test-[0-9a-f]{16}$/);
    expect(first).not.toBe(second);
    expect(readdirSync(dir)).toEqual(['home']);
  });

  it('refuses a prefix that could name another place', async () => {
    expect(await codeOf(ops.tmpPath('../escape'))).toBe('INVALID_PATH');
    expect(await codeOf(ops.tmpPath(''))).toBe('INVALID_PATH');
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

describe('localFileOpsHostFromEnv', () => {
  it('reads PATH and PATHEXT from the environment it is handed', () => {
    const host = localFileOpsHostFromEnv({ platform: 'linux', homeDir: '/h', tmpDir: '/t' }, { PATH: '/a:/b', PATHEXT: '.X' });
    expect(host).toEqual({ platform: 'linux', homeDir: '/h', tmpDir: '/t', pathEnv: '/a:/b', pathExt: '.X' });
  });

  it('finds Path in any case on win32, where variable names are case-insensitive', () => {
    const host = localFileOpsHostFromEnv({ platform: 'win32', homeDir: 'C:\\h', tmpDir: 'C:\\t' }, { Path: 'C:\\a;C:\\b', PathExt: '.EXE' });
    expect(host.pathEnv).toBe('C:\\a;C:\\b');
    expect(host.pathExt).toBe('.EXE');
  });

  it('treats an OS AZITO has no profile for as POSIX', () => {
    expect(localFileOpsHostFromEnv({ platform: 'freebsd', homeDir: '/h', tmpDir: '/t' }, {}).platform).toBe('linux');
    expect(localFileOpsHostFromEnv({ platform: 'darwin', homeDir: '/h', tmpDir: '/t' }, {}).platform).toBe('darwin');
  });
});
