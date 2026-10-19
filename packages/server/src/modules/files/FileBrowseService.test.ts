import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileBrowseService, FileBrowseError, MAX_FILE_SIZE } from './FileBrowseService';
import type { ServerConfig } from '../servers/Server';
import { FileOpsError, type IFileOps } from '../../shared/fs/fileOps';
import { LocalFileOps, localFileOpsHost } from '../../shared/fs/LocalFileOps';

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const localSrv = { type: 'local', name: 'local' } as unknown as ServerConfig;

function localFileOps(dir: string): LocalFileOps {
  return new LocalFileOps(localFileOpsHost({ platform: process.platform, homeDir: dir }));
}

/** A service over the files of this machine: the real file operations behind the factory. */
function serviceFor(ops: IFileOps): FileBrowseService {
  return new FileBrowseService({ getFileOps: () => ops });
}

async function statusOf(run: Promise<unknown>): Promise<number | string> {
  try {
    await run;
  } catch (err) {
    return err instanceof FileBrowseError ? err.status : `unexpected: ${(err as Error).message}`;
  }
  return 'resolved';
}

describe('FileBrowseService on a real directory', () => {
  let tmpDir: string;
  let svc: FileBrowseService;

  beforeEach(() => {
    tmpDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'azito-test-')));
    svc = serviceFor(localFileOps(tmpDir));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('listFiles', () => {
    it('lists directories first, then files by name, with sizes only on files', async () => {
      fs.mkdirSync(path.join(tmpDir, 'zdir'));
      fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'hello');
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), '');
      expect(await svc.listFiles(localSrv, tmpDir, false)).toEqual([
        { name: 'zdir', type: 'directory', path: path.join(tmpDir, 'zdir') },
        { name: 'a.txt', type: 'file', path: path.join(tmpDir, 'a.txt'), size: 0 },
        { name: 'b.txt', type: 'file', path: path.join(tmpDir, 'b.txt'), size: 5 },
      ]);
    });

    it('hides dotfiles unless asked', async () => {
      fs.writeFileSync(path.join(tmpDir, '.env'), 'x');
      fs.writeFileSync(path.join(tmpDir, 'a'), 'x');
      expect((await svc.listFiles(localSrv, tmpDir, false)).map((e) => e.name)).toEqual(['a']);
      expect((await svc.listFiles(localSrv, tmpDir, true)).map((e) => e.name)).toEqual(['.env', 'a']);
    });

    it('does not double the separator for a directory given with a trailing one', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a'), '');
      expect((await svc.listFiles(localSrv, tmpDir + path.sep, false))[0].path).toBe(tmpDir + path.sep + 'a');
    });

    it('answers 404 for a directory that is not there and 400 for a file', async () => {
      expect(await statusOf(svc.listFiles(localSrv, path.join(tmpDir, 'missing'), false))).toBe(404);
      fs.writeFileSync(path.join(tmpDir, 'f.txt'), '');
      expect(await statusOf(svc.listFiles(localSrv, path.join(tmpDir, 'f.txt'), false))).toBe(400);
    });
  });

  describe('listDirectories', () => {
    it('completes a partial name case-insensitively, skipping files and hidden directories', async () => {
      fs.mkdirSync(path.join(tmpDir, 'Project-A'));
      fs.mkdirSync(path.join(tmpDir, 'project-b'));
      fs.mkdirSync(path.join(tmpDir, '.project-hidden'));
      fs.mkdirSync(path.join(tmpDir, 'other'));
      fs.writeFileSync(path.join(tmpDir, 'project-file'), '');
      const found = await svc.listDirectories(localSrv, path.join(tmpDir, 'PROJ'));
      expect(found.sort()).toEqual([path.join(tmpDir, 'Project-A'), path.join(tmpDir, 'project-b')]);
    });

    it('lists every visible directory when the input ends with a separator', async () => {
      fs.mkdirSync(path.join(tmpDir, 'a'));
      fs.mkdirSync(path.join(tmpDir, 'b'));
      expect((await svc.listDirectories(localSrv, tmpDir + path.sep)).sort()).toEqual([path.join(tmpDir, 'a'), path.join(tmpDir, 'b')]);
    });

    it('has no candidates for a directory that does not exist', async () => {
      expect(await svc.listDirectories(localSrv, path.join(tmpDir, 'nope') + path.sep)).toEqual([]);
    });
  });

  describe('getFileContent', () => {
    it('returns text with language, size, mtime and a hash of its bytes', async () => {
      const file = path.join(tmpDir, 'a.ts');
      fs.writeFileSync(file, 'export const a = 1;\n');
      const result = await svc.getFileContent(localSrv, file);
      expect(result).toEqual({
        content: 'export const a = 1;\n',
        path: file,
        size: 20,
        language: 'typescript',
        mtime: fs.statSync(file).mtimeMs,
        hash: sha256('export const a = 1;\n'),
      });
    });

    it('hashes the bytes of the file, so the hash a save sends back is the one the host computes (even for bytes that are not valid UTF-8)', async () => {
      const file = path.join(tmpDir, 'latin1.txt');
      const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
      fs.writeFileSync(file, bytes);
      const read = await svc.getFileContent(localSrv, file);
      expect('hash' in read && read.hash).toBe(sha256(bytes));
      await expect(svc.writeFileContent(localSrv, file, 'replaced', ('mtime' in read ? read.mtime : 0), ('hash' in read ? read.hash : ''))).resolves.toBeTruthy();
    });

    it('returns an image and a PDF as base64', async () => {
      fs.writeFileSync(path.join(tmpDir, 'p.png'), Buffer.from([1, 2, 3]));
      fs.writeFileSync(path.join(tmpDir, 'd.pdf'), Buffer.from('%PDF'));
      expect(await svc.getFileContent(localSrv, path.join(tmpDir, 'p.png'))).toMatchObject({ type: 'image', mimeType: 'image/png', base64: 'AQID', size: 3 });
      expect(await svc.getFileContent(localSrv, path.join(tmpDir, 'd.pdf'))).toMatchObject({ type: 'pdf', mimeType: 'application/pdf', base64: Buffer.from('%PDF').toString('base64') });
    });

    it('answers 400 for a binary extension and for a NUL byte in a text file', async () => {
      fs.writeFileSync(path.join(tmpDir, 'a.zip'), 'x');
      fs.writeFileSync(path.join(tmpDir, 'nul.txt'), Buffer.from([0x61, 0, 0x62]));
      expect(await statusOf(svc.getFileContent(localSrv, path.join(tmpDir, 'a.zip')))).toBe(400);
      await expect(svc.getFileContent(localSrv, path.join(tmpDir, 'nul.txt'))).rejects.toThrow('Binary file cannot be displayed');
    });

    it('answers 400 with the limit in the message for a file that is too large', async () => {
      fs.writeFileSync(path.join(tmpDir, 'big.txt'), 'x'.repeat(MAX_FILE_SIZE + 1));
      await expect(svc.getFileContent(localSrv, path.join(tmpDir, 'big.txt'))).rejects.toThrow(/File too large \(\d+KB\)\. Maximum is 500KB\./);
      fs.writeFileSync(path.join(tmpDir, 'big.png'), Buffer.alloc(5 * 1024 * 1024 + 1));
      await expect(svc.getFileContent(localSrv, path.join(tmpDir, 'big.png'))).rejects.toThrow(/Image too large .* Maximum is 5MB\./);
      fs.writeFileSync(path.join(tmpDir, 'big.pdf'), Buffer.alloc(5 * 1024 * 1024 + 1));
      await expect(svc.getFileContent(localSrv, path.join(tmpDir, 'big.pdf'))).rejects.toThrow(/PDF too large .* Maximum is 5MB\./);
    });

    it('answers 400 for a directory and 404 for a path that is not there', async () => {
      expect(await statusOf(svc.getFileContent(localSrv, tmpDir))).toBe(400);
      expect(await statusOf(svc.getFileContent(localSrv, path.join(tmpDir, 'missing.txt')))).toBe(404);
    });
  });

  describe('downloadFile', () => {
    it('returns the bytes with a content type and the base name', async () => {
      fs.writeFileSync(path.join(tmpDir, 'data.json'), '{"a":1}');
      const result = await svc.downloadFile(localSrv, path.join(tmpDir, 'data.json'));
      expect(result.buffer.toString()).toBe('{"a":1}');
      expect(result.contentType).toBe('application/json');
      expect(result.basename).toBe('data.json');
    });

    it('falls back to octet-stream and refuses a directory', async () => {
      fs.writeFileSync(path.join(tmpDir, 'blob.xyz'), 'x');
      expect((await svc.downloadFile(localSrv, path.join(tmpDir, 'blob.xyz'))).contentType).toBe('application/octet-stream');
      expect(await statusOf(svc.downloadFile(localSrv, tmpDir))).toBe(400);
    });
  });

  describe('writeFileContent', () => {
    it('writes file and returns mtime and the hash of the new content', async () => {
      const filePath = path.join(tmpDir, 'test.txt');
      fs.writeFileSync(filePath, 'original');
      const result = await svc.writeFileContent(localSrv, filePath, 'updated');
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('updated');
      expect(result).toEqual({ mtime: fs.statSync(filePath).mtimeMs, hash: sha256('updated') });
    });

    it('rejects content exceeding MAX_FILE_SIZE', async () => {
      const filePath = path.join(tmpDir, 'large.txt');
      fs.writeFileSync(filePath, 'x');
      await expect(svc.writeFileContent(localSrv, filePath, 'x'.repeat(501 * 1024))).rejects.toThrow(FileBrowseError);
    });

    it('returns 409 on mtime conflict, carrying the current mtime', async () => {
      const filePath = path.join(tmpDir, 'conflict.txt');
      fs.writeFileSync(filePath, 'original');
      try {
        await svc.writeFileContent(localSrv, filePath, 'new content', Date.now() - 60000);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(FileBrowseError);
        expect((err as FileBrowseError).status).toBe(409);
        expect(JSON.parse((err as FileBrowseError).message)).toEqual({ conflict: true, currentMtime: fs.statSync(filePath).mtimeMs });
      }
    });

    it('writes successfully when mtime matches', async () => {
      const filePath = path.join(tmpDir, 'match.txt');
      fs.writeFileSync(filePath, 'original');
      const stat = fs.statSync(filePath);
      const result = await svc.writeFileContent(localSrv, filePath, 'new content', stat.mtimeMs);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('new content');
      expect(result.mtime).toBeGreaterThanOrEqual(stat.mtimeMs);
    });

    // Issue #27 review Important 3: `Math.abs(stat.mtimeMs - baseMtime) > 1000` let an external edit that landed within
    // the same second slip through silently. baseMtime round-trips the exact mtimeMs this service returned earlier.
    it('rejects a conflicting edit that landed within the same second (millisecond precision)', async () => {
      const filePath = path.join(tmpDir, 'same-second.txt');
      fs.writeFileSync(filePath, 'original');
      const baseDate = new Date(2026, 0, 1, 12, 0, 0, 100);
      fs.utimesSync(filePath, baseDate, baseDate);
      const staleBaseMtime = fs.statSync(filePath).mtimeMs;

      fs.writeFileSync(filePath, 'raced edit');
      const racedDate = new Date(2026, 0, 1, 12, 0, 0, 900);
      fs.utimesSync(filePath, racedDate, racedDate);

      await expect(svc.writeFileContent(localSrv, filePath, 'my edit', staleBaseMtime)).rejects.toMatchObject({ status: 409 });
    });

    // The content-hash lock catches an external edit by its bytes whatever the timing of the mtime.
    it('returns 409 on hash conflict even when mtime matches', async () => {
      const filePath = path.join(tmpDir, 'hash-conflict.txt');
      fs.writeFileSync(filePath, 'original');
      const stat = fs.statSync(filePath);
      await expect(svc.writeFileContent(localSrv, filePath, 'my edit', stat.mtimeMs, sha256('stale content the reader actually saw'))).rejects.toMatchObject({ status: 409 });
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('original');
    });

    it('writes successfully when the content hash matches', async () => {
      const filePath = path.join(tmpDir, 'hash-match.txt');
      fs.writeFileSync(filePath, 'original');
      const result = await svc.writeFileContent(localSrv, filePath, 'new content', undefined, sha256('original'));
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('new content');
      expect(result.hash).toBe(sha256('new content'));
    });

    it('force (no lock sent) bypasses both the mtime and hash conflict checks', async () => {
      const filePath = path.join(tmpDir, 'force.txt');
      fs.writeFileSync(filePath, 'original');
      const result = await svc.writeFileContent(localSrv, filePath, 'forced edit');
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('forced edit');
      expect(result.hash).toBe(sha256('forced edit'));
    });

    // Issue #27 review Critical 2 (the write half): a symlink swapped in at the save target between the route's
    // containment check and the write must not redirect the write to wherever it points.
    // Windows では動かない: シンボリックリンク作成に権限が要る（junction は IFileOps のテストで扱う）
    it.skipIf(process.platform === 'win32')('refuses to write through a symlink and leaves its target alone', async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-outside-'));
      const outsideFile = path.join(outsideDir, 'secret.txt');
      fs.writeFileSync(outsideFile, 'original outside content');
      const linkPath = path.join(tmpDir, 'escape-link.txt');
      fs.symlinkSync(outsideFile, linkPath);

      await expect(svc.writeFileContent(localSrv, linkPath, 'attacker-controlled content')).rejects.toMatchObject({ status: 400 });
      expect(fs.readFileSync(outsideFile, 'utf-8')).toBe('original outside content');
      fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    it('creates a file that does not exist yet', async () => {
      const filePath = path.join(tmpDir, 'brand-new.txt');
      await svc.writeFileContent(localSrv, filePath, 'hi');
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('hi');
    });

    it('does not let one save request block unrelated files from saving concurrently', async () => {
      const fileA = path.join(tmpDir, 'a.txt');
      const fileB = path.join(tmpDir, 'b.txt');
      fs.writeFileSync(fileA, 'a');
      fs.writeFileSync(fileB, 'b');
      const [resA, resB] = await Promise.all([
        svc.writeFileContent(localSrv, fileA, 'new a'),
        svc.writeFileContent(localSrv, fileB, 'new b'),
      ]);
      expect(resA.mtime).toBeGreaterThan(0);
      expect(resB.mtime).toBeGreaterThan(0);
      expect(fs.readFileSync(fileA, 'utf-8')).toBe('new a');
      expect(fs.readFileSync(fileB, 'utf-8')).toBe('new b');
    });
  });

  describe('resolveExistingTargetRealPath', () => {
    // Issue #27 review Critical 2: the containment check the PUT route runs on the parent directory alone can't see that
    // the save target itself is a symlink pointing outside workingDirectory. This resolves the target's real path so the
    // route can re-verify containment on it.
    // Windows では動かない: シンボリックリンク作成に権限が要る（junction は PathContainment のテストで扱う）
    it.skipIf(process.platform === 'win32')('resolves a symlinked target to its real (outside) path', async () => {
      const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'azito-outside-'));
      const outsideFile = path.join(outsideDir, 'secret.txt');
      fs.writeFileSync(outsideFile, 'secret');
      const linkPath = path.join(tmpDir, 'link.txt');
      fs.symlinkSync(outsideFile, linkPath);

      expect(await svc.resolveExistingTargetRealPath(localSrv, linkPath)).toBe(fs.realpathSync.native(outsideFile));
      fs.rmSync(outsideDir, { recursive: true, force: true });
    });

    it('returns null when the target does not exist yet', async () => {
      expect(await svc.resolveExistingTargetRealPath(localSrv, path.join(tmpDir, 'nope.txt'))).toBeNull();
    });
  });

  describe('createEntry', () => {
    it('creates a file', async () => {
      const filePath = path.join(tmpDir, 'newfile.txt');
      await svc.createEntry(localSrv, filePath, 'file');
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('');
    });

    it('creates a directory', async () => {
      const dirPath = path.join(tmpDir, 'newdir');
      await svc.createEntry(localSrv, dirPath, 'directory');
      expect(fs.statSync(dirPath).isDirectory()).toBe(true);
    });

    it('throws 409 if already exists', async () => {
      const filePath = path.join(tmpDir, 'existing.txt');
      fs.writeFileSync(filePath, 'hello');
      await expect(svc.createEntry(localSrv, filePath, 'file')).rejects.toThrow('Already exists');
      expect(await statusOf(svc.createEntry(localSrv, filePath, 'file'))).toBe(409);
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('hello');
    });
  });

  describe('ensureDirectory', () => {
    it('creates a nested directory that does not exist yet (mkdir -p semantics)', async () => {
      const target = path.join(tmpDir, 'a', 'b', 'c');
      expect(await svc.ensureDirectory(localSrv, target)).toEqual({ created: true });
      expect(fs.statSync(target).isDirectory()).toBe(true);
    });

    it('is a no-op when the directory already exists', async () => {
      const target = path.join(tmpDir, 'already');
      fs.mkdirSync(target);
      expect(await svc.ensureDirectory(localSrv, target)).toEqual({ created: false });
    });

    it('throws 409 when the path exists but is not a directory', async () => {
      const target = path.join(tmpDir, 'file.txt');
      fs.writeFileSync(target, 'hello');
      await expect(svc.ensureDirectory(localSrv, target)).rejects.toThrow('not a directory');
      expect(await statusOf(svc.ensureDirectory(localSrv, target))).toBe(409);
    });
  });

  describe('deleteEntry', () => {
    it('deletes a file', async () => {
      const filePath = path.join(tmpDir, 'to-delete.txt');
      fs.writeFileSync(filePath, 'content');
      await svc.deleteEntry(localSrv, filePath);
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('deletes a directory recursively', async () => {
      const dirPath = path.join(tmpDir, 'to-delete-dir');
      fs.mkdirSync(dirPath);
      fs.writeFileSync(path.join(dirPath, 'child.txt'), 'x');
      await svc.deleteEntry(localSrv, dirPath);
      expect(fs.existsSync(dirPath)).toBe(false);
    });

    it('throws 404 if not found', async () => {
      await expect(svc.deleteEntry(localSrv, path.join(tmpDir, 'nope'))).rejects.toThrow('Not found');
      expect(await statusOf(svc.deleteEntry(localSrv, path.join(tmpDir, 'nope')))).toBe(404);
    });
  });

  describe('renameEntry', () => {
    it('renames a file', async () => {
      const oldPath = path.join(tmpDir, 'old.txt');
      fs.writeFileSync(oldPath, 'content');
      await svc.renameEntry(localSrv, oldPath, 'new.txt');
      expect(fs.existsSync(oldPath)).toBe(false);
      expect(fs.readFileSync(path.join(tmpDir, 'new.txt'), 'utf-8')).toBe('content');
    });

    it('throws 409 if target already exists', async () => {
      const oldPath = path.join(tmpDir, 'a.txt');
      fs.writeFileSync(oldPath, 'a');
      fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'b');
      await expect(svc.renameEntry(localSrv, oldPath, 'b.txt')).rejects.toThrow('Already exists');
      expect(fs.readFileSync(path.join(tmpDir, 'b.txt'), 'utf-8')).toBe('b');
    });

    it('throws 404 if source not found', async () => {
      await expect(svc.renameEntry(localSrv, path.join(tmpDir, 'nope'), 'new')).rejects.toThrow('Not found');
    });
  });
});

describe('FileBrowseService with a host whose operations refuse', () => {
  /** File operations that all fail the same way: what the service makes of each refusal is what is under test. */
  function refusing(error: FileOpsError): IFileOps {
    const fail = async (): Promise<never> => { throw error; };
    return { platform: 'linux', list: fail, stat: fail, read: fail, write: fail, create: fail, remove: fail, rename: fail, realpath: fail };
  }
  const srv = { type: 'agent', name: 'a' } as unknown as ServerConfig;

  it('turns a CONFLICT into a 409 whose body carries the current mtime and whether the hash could be checked', async () => {
    const lock = refusing(new FileOpsError('CONFLICT', 'changed', { currentMtimeMs: 42 }));
    await expect(serviceFor(lock).writeFileContent(srv, '/w/a.txt', 'x', 1)).rejects.toMatchObject({ status: 409, message: JSON.stringify({ conflict: true, currentMtime: 42 }) });

    const noHashTool = refusing(new FileOpsError('CONFLICT', 'no hash', { currentMtimeMs: null, hashUnavailable: true }));
    await expect(serviceFor(noHashTool).writeFileContent(srv, '/w/a.txt', 'x', 1, sha256('x'))).rejects.toMatchObject({
      status: 409,
      message: JSON.stringify({ conflict: true, currentMtime: null, hashUnavailable: true }),
    });
  });

  it('answers what each refusal has always meant to the file APIs', async () => {
    const answer = (code: FileOpsError['code']) => statusOf(serviceFor(refusing(new FileOpsError(code, 'x'))).getFileContent(srv, '/w/a.txt'));
    expect(await answer('NOT_FOUND')).toBe(404);
    expect(await answer('NOT_A_FILE')).toBe(400);
    expect(await answer('INVALID_PATH')).toBe(400);
    expect(await answer('FAILED')).toBe(500);
    // Anything else is not translated: the route answers it as a 500 with its message.
    expect(await answer('PERMISSION_DENIED')).toBe('unexpected: x');
  });

  it('does not hide an unexpected error as "not found"', async () => {
    const boom = refusing(new FileOpsError('PERMISSION_DENIED', 'EACCES: permission denied'));
    await expect(serviceFor(boom).resolveExistingTargetRealPath(srv, '/w/a.txt')).rejects.toThrow('EACCES');
  });
});

describe('FileBrowseService on a host with Windows path rules', () => {
  /** A host that records the paths it is asked for: only the service's path handling is under test. */
  function recording(): { ops: IFileOps; seen: string[] } {
    const seen: string[] = [];
    const ops: IFileOps = {
      platform: 'win32',
      list: async (dir) => { seen.push(dir); return [{ name: 'a.txt', kind: 'file', size: 1 }, { name: 'Sub', kind: 'directory' }]; },
      stat: async () => null,
      read: async (p) => { seen.push(p); return { data: Buffer.from('x'), stat: { kind: 'file', size: 1, mtimeMs: 1, mode: 0o644 } }; },
      write: async () => ({ mtimeMs: 1, sha256: sha256('x') }),
      create: async () => ({ created: true }),
      remove: async (p) => { seen.push(p); },
      rename: async (from, to) => { seen.push(from, to); },
      realpath: async (p) => p,
    };
    return { ops, seen };
  }
  const srv = { type: 'agent', name: 'win' } as unknown as ServerConfig;

  it('joins entries with a backslash, and reads the extension of a Windows path', async () => {
    const { ops } = recording();
    const svc = serviceFor(ops);
    expect((await svc.listFiles(srv, 'C:\\work', false)).map((e) => e.path)).toEqual(['C:\\work\\Sub', 'C:\\work\\a.txt']);
    expect((await svc.listFiles(srv, 'C:\\work\\', false)).map((e) => e.path)).toEqual(['C:\\work\\Sub', 'C:\\work\\a.txt']);
    expect(await svc.getFileContent(srv, 'C:\\work\\main.ts')).toMatchObject({ language: 'typescript' });
    expect((await svc.downloadFile(srv, 'C:\\work\\data.json')).basename).toBe('data.json');
  });

  it('renames within the directory of the Windows path', async () => {
    const { ops, seen } = recording();
    await serviceFor(ops).renameEntry(srv, 'C:\\work\\old.txt', 'new.txt');
    expect(seen).toEqual(['C:\\work\\old.txt', 'C:\\work\\new.txt']);
  });

  it('completes a directory name from a partial Windows path', async () => {
    const { ops } = recording();
    expect(await serviceFor(ops).listDirectories(srv, 'C:\\work\\su')).toEqual(['C:\\work\\Sub']);
  });
});

describe('FileBrowseService.writeFileContent concurrency', () => {
  // The lock check and the replace are separate steps on the host, with an await gap between them. Without per-path
  // serialization in the hub, two saves of the same stale snapshot could both pass the check and the second would
  // silently clobber the first. The host here is a controlled stand-in whose mtime advances only when a write lands.
  it('serializes concurrent saves to the same path so the second sees a conflict, not a silent overwrite', async () => {
    let mtimeMs = 100_000;
    const baseMtime = mtimeMs;
    const writes: string[] = [];
    const ops = {
      platform: 'linux',
      write: async (_path: string, data: Buffer, options?: { expect?: { mtimeMs?: number } }) => {
        const expected = options?.expect?.mtimeMs;
        if (expected !== undefined && expected !== mtimeMs) throw new FileOpsError('CONFLICT', 'changed', { currentMtimeMs: mtimeMs });
        await new Promise((resolve) => setTimeout(resolve, 20));
        mtimeMs += 1000;
        writes.push(data.toString());
        return { mtimeMs, sha256: sha256(data) };
      },
    } as unknown as IFileOps;
    const service = serviceFor(ops);
    const srv = { name: 'shared', type: 'agent' } as unknown as ServerConfig;

    const results = await Promise.allSettled([
      service.writeFileContent(srv, '/tmp/shared.txt', 'edit A', baseMtime),
      service.writeFileContent(srv, '/tmp/shared.txt', 'edit B', baseMtime),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ status: 409 });
    expect(writes).toEqual(['edit A']);
  });
});
