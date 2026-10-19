import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
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
        { name: '.hidden', kind: 'file', size: 0, mtimeMs: expect.any(Number) },
        { name: 'a.txt', kind: 'file', size: 5, mtimeMs: expect.any(Number) },
        { name: 'sub', kind: 'directory' },
      ]);
      const listed = entries.find((e) => e.name === 'a.txt')!;
      expect(Math.abs(listed.mtimeMs! - statSync(path.join(odd, 'a.txt')).mtimeMs)).toBeLessThan(1000);
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

  describe('walk', () => {
    const options = { excludeNames: [] as string[], maxEntries: 1000, timeBudgetMs: 10_000 };
    const files = (...names: string[]): void => {
      for (const name of names) {
        mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        writeFileSync(path.join(dir, name), 'x');
      }
    };

    it('lists the regular files at any depth with their mtime, in one command', async () => {
      files('b.txt', 'sub/deep/y.txt', 'a.txt');
      sh.commands.length = 0;

      const { entries, truncated } = await ops.walk(dir, options);

      expect(entries.map((e) => e.path).sort()).toEqual(['a.txt', 'b.txt', 'sub/deep/y.txt']);
      expect(Math.abs(entries.find((e) => e.path === 'a.txt')!.mtimeMs - statSync(path.join(dir, 'a.txt')).mtimeMs)).toBeLessThan(1000);
      expect(truncated).toBe(false);
      expect(sh.commands).toHaveLength(1);
    });

    it('prunes excluded names and honors maxDepth', async () => {
      files('keep.ts', 'node_modules/p/a.js', 'a/node_modules/b.js', 'a/skip.log', 'a/ok.ts', 'a/b/deep.ts');

      expect((await ops.walk(dir, { ...options, excludeNames: ['node_modules', '*.log'] })).entries.map((e) => e.path).sort()).toEqual(['a/b/deep.ts', 'a/ok.ts', 'keep.ts']);
      expect((await ops.walk(dir, { ...options, maxDepth: 0 })).entries.map((e) => e.path)).toEqual(['keep.ts']);
      expect((await ops.walk(dir, { ...options, maxDepth: 1 })).entries.map((e) => e.path).sort()).toEqual(['a/ok.ts', 'a/skip.log', 'keep.ts']);
    });

    it('stops at maxEntries and says so', async () => {
      files('a.txt', 'b.txt', 'c.txt');

      const result = await ops.walk(dir, { ...options, maxEntries: 2 });

      expect(result.entries).toHaveLength(2);
      expect(result.truncated).toBe(true);
    });

    it('quotes a root that is hostile to a shell, and is NOT_FOUND for one that is not a directory', async () => {
      const odd = path.join(dir, "it's $(touch pwned)");
      mkdirSync(odd);
      writeFileSync(path.join(odd, 'a.txt'), '');

      expect((await ops.walk(odd, options)).entries.map((e) => e.path)).toEqual(['a.txt']);
      expect(existsSync(path.join(dir, 'pwned'))).toBe(false);
      expect(await codeOf(ops.walk(path.join(dir, 'missing'), options))).toBe('NOT_FOUND');
    });

    it('reports an exec that ran out of time as truncated, with nothing', async () => {
      const slow = new ShellFileOps({ exec: async () => { throw Object.assign(new Error('timed out'), { killed: true }); } });

      expect(await slow.walk(dir, options)).toEqual({ entries: [], truncated: true });
    });
  });

  describe('replaceDirectory', () => {
    const tree = (name: string, content: string): string => {
      const full = path.join(dir, name);
      mkdirSync(full, { recursive: true });
      writeFileSync(path.join(full, 'f.txt'), content);
      return full;
    };

    it('replaces the target with the staging directory in one command and leaves no backup', async () => {
      const target = tree('target', 'old');
      const staging = tree('staging', 'new');
      sh.commands.length = 0;

      await ops.replaceDirectory(staging, target);

      expect(readFileSync(path.join(target, 'f.txt'), 'utf8')).toBe('new');
      expect(existsSync(staging)).toBe(false);
      expect(readdirSync(dir).filter((n) => n.includes('azito-old'))).toEqual([]);
      expect(sh.commands).toHaveLength(1);
    });

    it('moves into a missing target, and keeps the old tree when the staging directory is missing', async () => {
      await ops.replaceDirectory(tree('s1', 'new'), path.join(dir, 'fresh'));
      expect(readFileSync(path.join(dir, 'fresh', 'f.txt'), 'utf8')).toBe('new');

      const target = tree('target', 'old');
      expect(await codeOf(ops.replaceDirectory(path.join(dir, 'missing'), target))).toBe('NOT_FOUND');
      expect(readFileSync(path.join(target, 'f.txt'), 'utf8')).toBe('old');
    });
  });

  describe('stat withAge', () => {
    it('reports the age by the host\'s own clock, only when asked', async () => {
      writeFileSync(path.join(dir, 'f'), 'x');
      const old = (Date.now() - 10 * 60 * 1000) / 1000;
      utimesSync(path.join(dir, 'f'), old, old);

      const aged = await ops.stat(path.join(dir, 'f'), { withAge: true });

      expect(aged?.ageMs).toBeGreaterThan(9.9 * 60 * 1000);
      expect(aged?.ageMs).toBeLessThan(10.5 * 60 * 1000);
      expect((await ops.stat(path.join(dir, 'f')))?.ageMs).toBeUndefined();
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

    it('reads only the first headBytes of a file when asked', async () => {
      writeFileSync(path.join(dir, 'rollout'), 'first line\nsecond line\n');
      const head = await ops.read(path.join(dir, 'rollout'), { headBytes: 10 });
      expect(head.data.toString()).toBe('first line');
      expect(head.stat.size).toBe(23);
      expect((await ops.read(path.join(dir, 'rollout'), { headBytes: 1000 })).data.toString()).toBe('first line\nsecond line\n');
      writeFileSync(path.join(dir, 'empty'), '');
      expect((await ops.read(path.join(dir, 'empty'), { headBytes: 10 })).data.length).toBe(0);
    });

    it.skipIf(process.getuid?.() === 0)('fails on a file it cannot read instead of returning it as empty', async () => {
      const locked = path.join(dir, 'locked');
      writeFileSync(locked, 'secret');
      chmodSync(locked, 0o000);

      expect(await codeOf(ops.read(locked, { headBytes: 10 }))).toBe('FAILED');
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
