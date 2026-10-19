import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import * as path from 'path';
import { FileOpsError, type FileOpsErrorCode } from '../../../shared/fs/fileOps';
import { ShellFileOps } from './ShellFileOps';
import type { ExecResult } from './ServerTransport';

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** An agent's `/api/exec` in one process: `/bin/sh -c`, the real exit code, stdout and stderr. */
function shell(): { exec: (command: string) => Promise<ExecResult>; commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    exec: (command) => new Promise((resolve) => {
      commands.push(command);
      execFile('/bin/sh', ['-c', command], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        const raw = (err as { code?: unknown } | null)?.code;
        resolve({ stdout, stderr, code: err ? (typeof raw === 'number' ? raw : 1) : 0 });
      });
    }),
  };
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

// A Unix agent's shell commands: they need /bin/sh and GNU tools, so they run on Linux/macOS only.
describe.skipIf(process.platform === 'win32')('ShellFileOps against a real shell', () => {
  let dir: string;
  let sh: ReturnType<typeof shell>;
  let ops: ShellFileOps;

  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'azito-shellfileops-')));
    sh = shell();
    ops = new ShellFileOps(sh);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is a POSIX host', () => {
    expect(ops.platform).toBe('linux');
  });

  describe('list', () => {
    it('lists kinds and sizes, quoting a directory name that is hostile to a shell', async () => {
      const odd = path.join(dir, "it's $(touch pwned); `id`");
      mkdirSync(odd);
      writeFileSync(path.join(odd, 'a.txt'), 'hello');
      mkdirSync(path.join(odd, 'sub'));
      writeFileSync(path.join(odd, '.hidden'), '');
      const entries = (await ops.list(odd)).sort((a, b) => a.name.localeCompare(b.name));
      expect(entries).toEqual([
        { name: '.hidden', kind: 'file', size: 0 },
        { name: 'a.txt', kind: 'file', size: 5 },
        { name: 'sub', kind: 'directory' },
      ]);
      expect(existsSync(path.join(dir, 'pwned'))).toBe(false);
    });

    it('reports a link as one', async () => {
      writeFileSync(path.join(dir, 't'), 'abc');
      symlinkSync('t', path.join(dir, 'l'));
      expect((await ops.list(dir)).find((e) => e.name === 'l')?.kind).toBe('symlink');
    });
  });

  describe('stat', () => {
    it('reads kind, size, mtime and permission bits', async () => {
      const file = path.join(dir, 'f.sh');
      writeFileSync(file, 'four');
      chmodSync(file, 0o750);
      const stat = await ops.stat(file);
      expect(stat).toMatchObject({ kind: 'file', size: 4, mode: 0o750 });
      expect(Math.abs(stat!.mtimeMs - statSync(file).mtimeMs)).toBeLessThan(1000);
      expect((await ops.stat(dir))?.kind).toBe('directory');
    });

    it('is null for a missing path, and a link is followed unless asked not to', async () => {
      expect(await ops.stat(path.join(dir, 'missing'))).toBeNull();
      writeFileSync(path.join(dir, 't'), 'abc');
      symlinkSync('t', path.join(dir, 'l'));
      expect((await ops.stat(path.join(dir, 'l')))?.kind).toBe('file');
      expect((await ops.stat(path.join(dir, 'l'), { followLinks: false }))?.kind).toBe('symlink');
    });
  });

  describe('read', () => {
    it('returns the exact bytes, a trailing newline included', async () => {
      const bytes = Buffer.from('line one\nline two\n');
      writeFileSync(path.join(dir, 'f.txt'), bytes);
      const { data, stat } = await ops.read(path.join(dir, 'f.txt'));
      expect(data.equals(bytes)).toBe(true);
      expect(stat.size).toBe(bytes.length);
    });

    it('returns an empty file as empty, and binary content untouched', async () => {
      writeFileSync(path.join(dir, 'empty'), '');
      expect((await ops.read(path.join(dir, 'empty'))).data.length).toBe(0);
      const binary = Buffer.from([0, 255, 10, 13, 0, 1]);
      writeFileSync(path.join(dir, 'bin'), binary);
      expect((await ops.read(path.join(dir, 'bin'))).data.equals(binary)).toBe(true);
    });

    it('refuses a missing path, a directory and a file over the limit', async () => {
      expect(await codeOf(ops.read(path.join(dir, 'missing')))).toBe('NOT_FOUND');
      expect(await codeOf(ops.read(dir))).toBe('NOT_A_FILE');
      writeFileSync(path.join(dir, 'big'), 'x'.repeat(50));
      expect(await codeOf(ops.read(path.join(dir, 'big'), { maxBytes: 10 }))).toBe('TOO_LARGE');
    });

    it('reads with a redirection, not a path argument (BSD base64 has no --)', async () => {
      writeFileSync(path.join(dir, 'f.txt'), 'x');
      await ops.read(path.join(dir, 'f.txt'));
      const readCommand = sh.commands.find((c) => c.includes('AZITO_READ_OK'));
      expect(readCommand).toContain(`base64 -w0 < '${path.join(dir, 'f.txt')}'`);
    });
  });

  describe('write', () => {
    it('creates and replaces a file, leaving no staging file', async () => {
      const file = path.join(dir, 'f.txt');
      const created = await ops.write(file, Buffer.from('v1\n'));
      expect(readFileSync(file, 'utf8')).toBe('v1\n');
      expect(created.sha256).toBe(sha256('v1\n'));
      const replaced = await ops.write(file, Buffer.from('v2\n'));
      expect(readFileSync(file, 'utf8')).toBe('v2\n');
      expect(Math.abs(replaced.mtimeMs - statSync(file).mtimeMs)).toBeLessThan(1000);
      expect(readdirSync(dir)).toEqual(['f.txt']);
    });

    it('keeps the permission bits of an existing file', async () => {
      const file = path.join(dir, 'run.sh');
      writeFileSync(file, '#!/bin/sh\n');
      chmodSync(file, 0o750);
      await ops.write(file, Buffer.from('#!/bin/sh\necho hi\n'));
      expect(statSync(file).mode & 0o777).toBe(0o750);
    });

    it('splits a large body into chunks so no command exceeds the argument size limit', async () => {
      const file = path.join(dir, 'big.txt');
      const body = 'abcdefghij'.repeat(20_000);
      await ops.write(file, Buffer.from(body));
      expect(readFileSync(file, 'utf8')).toBe(body);
      expect(sh.commands.filter((c) => c.startsWith('printf')).length).toBeGreaterThan(1);
      expect(Math.max(...sh.commands.map((c) => c.length))).toBeLessThan(120_000);
    });

    it('quotes the path everywhere, including in the cleanup trap', async () => {
      const file = path.join(dir, "it's $(touch pwned); x.txt");
      await ops.write(file, Buffer.from('ok'));
      expect(readFileSync(file, 'utf8')).toBe('ok');
      expect(existsSync(path.join(dir, 'pwned'))).toBe(false);
      expect(readdirSync(dir)).toEqual(["it's $(touch pwned); x.txt"]);
    });

    it('stages the upload owner-only (umask 077)', async () => {
      await ops.write(path.join(dir, 'f.txt'), Buffer.from('x'));
      expect(sh.commands.some((c) => /^umask 077; : > /.test(c))).toBe(true);
    });

    describe('optimistic lock', () => {
      it('writes when the mtime and hash match', async () => {
        const file = path.join(dir, 'f.txt');
        writeFileSync(file, 'v1');
        await ops.write(file, Buffer.from('v2'), { expect: { mtimeMs: statSync(file).mtimeMs, sha256: sha256('v1') } });
        expect(readFileSync(file, 'utf8')).toBe('v2');
      });

      it('is a CONFLICT with the current mtime when the mtime differs by more than the precision', async () => {
        const file = path.join(dir, 'f.txt');
        writeFileSync(file, 'v1');
        const err = await ops.write(file, Buffer.from('v2'), { expect: { mtimeMs: statSync(file).mtimeMs - 5000 } }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(FileOpsError);
        expect((err as FileOpsError).code).toBe('CONFLICT');
        expect(typeof (err as FileOpsError).details.currentMtimeMs).toBe('number');
        expect(readFileSync(file, 'utf8')).toBe('v1');
      });

      it('is a CONFLICT when the content differs although the mtime matches', async () => {
        const file = path.join(dir, 'f.txt');
        writeFileSync(file, 'v1');
        expect(await codeOf(ops.write(file, Buffer.from('v2'), { expect: { mtimeMs: statSync(file).mtimeMs, sha256: sha256('other') } }))).toBe('CONFLICT');
        expect(readFileSync(file, 'utf8')).toBe('v1');
      });

      it('fails closed when the mtime cannot be read (the file is gone)', async () => {
        const err = await ops.write(path.join(dir, 'gone.txt'), Buffer.from('x'), { expect: { mtimeMs: 1 } }).catch((e: unknown) => e);
        expect(err).toMatchObject({ code: 'CONFLICT', details: { currentMtimeMs: null } });
      });
    });
  });

  describe('create / remove / rename', () => {
    it('creates a file and a directory (recursively on request), refusing an existing entry', async () => {
      expect(await ops.create(path.join(dir, 'f.txt'), 'file')).toEqual({ created: true });
      expect(await ops.create(path.join(dir, 'a', 'b'), 'directory', { recursive: true })).toEqual({ created: true });
      expect(await ops.create(path.join(dir, 'a', 'b'), 'directory', { recursive: true })).toEqual({ created: false });
      expect(await codeOf(ops.create(path.join(dir, 'f.txt'), 'file'))).toBe('ALREADY_EXISTS');
      expect(await codeOf(ops.create(path.join(dir, 'f.txt'), 'directory', { recursive: true }))).toBe('ALREADY_EXISTS');
      expect(statSync(path.join(dir, 'f.txt')).size).toBe(0);
    });

    it('removes a path with everything in it, or says it is not there', async () => {
      mkdirSync(path.join(dir, 'd', 'inner'), { recursive: true });
      await ops.remove(path.join(dir, 'd'));
      expect(existsSync(path.join(dir, 'd'))).toBe(false);
      expect(await codeOf(ops.remove(path.join(dir, 'd')))).toBe('NOT_FOUND');
    });

    it('renames without overwriting', async () => {
      writeFileSync(path.join(dir, 'a'), 'a');
      writeFileSync(path.join(dir, 'b'), 'b');
      await ops.rename(path.join(dir, 'a'), path.join(dir, 'c'));
      expect(readFileSync(path.join(dir, 'c'), 'utf8')).toBe('a');
      expect(await codeOf(ops.rename(path.join(dir, 'c'), path.join(dir, 'b')))).toBe('ALREADY_EXISTS');
      expect(await codeOf(ops.rename(path.join(dir, 'missing'), path.join(dir, 'x')))).toBe('NOT_FOUND');
    });
  });

  describe('realpath', () => {
    it('resolves a directory, a file and a link to a file or directory', async () => {
      mkdirSync(path.join(dir, 'real'));
      writeFileSync(path.join(dir, 'real', 'f.txt'), '');
      symlinkSync('real', path.join(dir, 'dirlink'));
      symlinkSync('real/f.txt', path.join(dir, 'filelink'));
      expect(await ops.realpath(path.join(dir, 'real'))).toBe(path.join(dir, 'real'));
      expect(await ops.realpath(path.join(dir, 'real', 'f.txt'))).toBe(path.join(dir, 'real', 'f.txt'));
      expect(await ops.realpath(path.join(dir, 'dirlink'))).toBe(path.join(dir, 'real'));
      expect(await ops.realpath(path.join(dir, 'filelink'))).toBe(path.join(dir, 'real', 'f.txt'));
    });

    it('is NOT_FOUND for a missing path and refuses a line terminator', async () => {
      expect(await codeOf(ops.realpath(path.join(dir, 'missing')))).toBe('NOT_FOUND');
      expect(await codeOf(ops.realpath(`${dir}\nx`))).toBe('INVALID_PATH');
    });

    it('keeps leading and trailing whitespace of the resolved path (only the terminator is removed)', async () => {
      mkdirSync(path.join(dir, 'proj '));
      expect(await ops.realpath(path.join(dir, 'proj '))).toBe(path.join(dir, 'proj '));
    });

    it('expands a leading ~ with $HOME, and the rest stays quoted', async () => {
      const home = realpathSync.native(process.env.HOME ?? '/');
      expect(await ops.realpath('~')).toBe(home);
      expect(sh.commands[0]).toContain('p="$HOME"');
    });
  });

  describe('which / tmpPath', () => {
    it('finds a command on the host and not a missing one', async () => {
      expect(await ops.which('sh')).toMatch(/\/sh$/);
      expect(await ops.which('azito-no-such-command-xyz')).toBeNull();
    });

    it('names a path under /tmp without running anything', async () => {
      const before = sh.commands.length;
      expect(await ops.tmpPath('azito-x')).toMatch(/^\/tmp\/azito-x-[0-9a-f]{16}$/);
      expect(sh.commands.length).toBe(before);
    });
  });
});

// The details that need a host whose tools differ (BSD/macOS, no hash tool): the command texts and what is made of their output.
describe('ShellFileOps with scripted output', () => {
  const answering = (answer: (command: string) => string): { ops: ShellFileOps; commands: string[] } => {
    const commands: string[] = [];
    return {
      commands,
      ops: new ShellFileOps({ exec: async (command: string) => { commands.push(command); return { stdout: answer(command), stderr: '', code: 0 }; } }),
    };
  };

  it('falls back to BSD base64 -D and BSD stat when the GNU forms fail', async () => {
    const { ops, commands } = answering((c) => (c.includes('stat -L -c') ? '1 1750000000 644\n' : 'f\n'));
    await ops.stat('/srv/f').catch(() => undefined);
    expect(commands.some((c) => c.includes("stat -L -f '%z %m %Lp'"))).toBe(true);

    const writer = answering((c) => (c.includes('AZITO_WRITE_OK') || c.includes('wc -c') ? 'AZITO_WRITE_OK\n' : c.startsWith('if [ -d') ? 'f\n' : '1 1750000000 644\n'));
    await writer.ops.write('/srv/f', Buffer.from('x'));
    expect(writer.commands.find((c) => c.includes('wc -c'))).toContain('base64 -D <');
  });

  it('fails closed when a content hash was asked for and the host has no hash tool', async () => {
    const { ops } = answering((c) => (c.startsWith('if [ -d') ? 'f\n' : c.includes('sha256sum') ? '' : '1 1750000000 644\n'));
    const err = await ops.write('/srv/f', Buffer.from('x'), { expect: { sha256: sha256('x') } }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'CONFLICT', details: { currentMtimeMs: null, hashUnavailable: true } });
  });

  it('tolerates a second of mtime difference on a host whose stat has whole seconds only, and not on one with sub-second stat', async () => {
    const wholeSeconds = answering((c) => (c.startsWith('if [ -d') ? 'f\n' : '10 1750000000 644\n'));
    await expect(wholeSeconds.ops.write('/srv/f', Buffer.from('x'), { expect: { mtimeMs: 1750000000500 } })).rejects.not.toMatchObject({ code: 'CONFLICT' });

    const subSecond = answering((c) => (c.startsWith('if [ -d') ? 'f\n' : '10 1750000000.123456789 644\n'));
    await expect(subSecond.ops.write('/srv/f', Buffer.from('x'), { expect: { mtimeMs: 1750000000500 } })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('is not reported as written without the success marker', async () => {
    const { ops } = answering((c) => (c.startsWith('if [ -d') ? 'f\n' : '1 1750000000 644\n'));
    await expect(ops.write('/srv/f', Buffer.from('x'))).rejects.toMatchObject({ code: 'FAILED', message: 'Failed to write file' });
  });

  it('is not reported as read without the success marker or with a size that differs from stat', async () => {
    const noMarker = answering((c) => (c.startsWith('if [ -d') ? 'f\n' : c.includes('base64') ? '' : '5 1750000000 644\n'));
    await expect(noMarker.ops.read('/srv/f')).rejects.toMatchObject({ code: 'FAILED', message: 'Failed to read file' });

    const shortRead = answering((c) => (c.startsWith('if [ -d') ? 'f\n' : c.includes('base64') ? `${Buffer.from('ab').toString('base64')}\nAZITO_READ_OK\n` : '5 1750000000 644\n'));
    await expect(shortRead.ops.read('/srv/f')).rejects.toMatchObject({ code: 'FAILED', message: expect.stringContaining('size mismatch') });
  });
});
