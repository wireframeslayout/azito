import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { scanFilesForContent } from './contentSearch';
import { CONTENT_SEARCH_MAX_FILE_BYTES, CONTENT_SEARCH_MAX_LINE_CHARS, CONTENT_SEARCH_MAX_RESULT_BYTES, FileOpsError, type ContentSearchOptions } from './fileOps';
import { executeFileOp, fileOpRequestSchema, RemoteFileOps } from './fileOpsWire';
import { LocalFileOps, localFileOpsHost } from './LocalFileOps';

let dir: string;
let ops: LocalFileOps;

const BASE: ContentSearchOptions = {
  query: 'needle', caseSensitive: false, wholeWord: false, regex: false, include: [], exclude: [], maxHits: 200, timeBudgetMs: 10_000,
};

function put(relative: string, content: string | Buffer): void {
  const target = path.join(dir, ...relative.split('/'));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

const search = (overrides: Partial<ContentSearchOptions> = {}) => ops.searchContent(dir, { ...BASE, ...overrides });

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'azito-contentsearch-')));
  ops = new LocalFileOps(localFileOpsHost({ platform: process.platform, homeDir: dir }));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('LocalFileOps.searchContent', () => {
  it('reports the line, the column and the match of each hit, with a path relative to the root and always with `/`', async () => {
    put('src/deep/a.ts', 'first\nthe Needle is here\n');
    const result = await search();
    expect(result).toEqual({
      hits: [{ path: 'src/deep/a.ts', line: 2, column: 5, text: 'the Needle is here', matchStart: 4, matchEnd: 10 }],
      truncated: false,
      timedOut: false,
    });
  });

  it('takes the carriage return off lines of a CRLF file (built here, so a checkout\'s line-ending rules cannot change it)', async () => {
    put('crlf.txt', ['one', 'a needle', 'three', ''].join('\r\n'));
    const { hits } = await search();
    expect(hits.map((h) => [h.line, h.text])).toEqual([[2, 'a needle']]);
  });

  it('does not count the empty text after the last line terminator as a line', async () => {
    put('a.txt', 'x\n');
    expect((await search({ query: '^$', regex: true })).hits).toEqual([]);
  });

  it('honours case sensitivity', async () => {
    put('a.txt', 'Needle\nneedle\n');
    expect((await search({ caseSensitive: true })).hits.map((h) => h.line)).toEqual([2]);
    expect((await search({ caseSensitive: false })).hits.map((h) => h.line)).toEqual([1, 2]);
  });

  it('matches a whole word only, and treats the query as text unless it is a regular expression', async () => {
    put('a.txt', 'needles\nneedle.\nneedle_x\nsome(needle)\n');
    expect((await search({ wholeWord: true })).hits.map((h) => h.line)).toEqual([2, 4]);
    put('b.txt', 'a+b\naab\n');
    expect((await search({ query: 'a+b' })).hits.map((h) => [h.path, h.line])).toEqual([['b.txt', 1]]);
    expect((await search({ query: 'a+b', regex: true })).hits.map((h) => [h.path, h.line])).toEqual([['b.txt', 2]]);
  });

  it('keeps a whole-word expression from escaping its wrapper', async () => {
    put('a.txt', 'xfoo\nfoo\n');
    expect((await search({ query: 'foo|bar', regex: true, wholeWord: true })).hits.map((h) => h.line)).toEqual([2]);
    expect((await search({ query: 'foo)(', regex: true, wholeWord: true })).hits).toEqual([]);
  });

  it('has no hits for an expression that cannot be compiled', async () => {
    put('a.txt', 'needle\n');
    expect(await search({ query: '(', regex: true })).toEqual({ hits: [], truncated: false, timedOut: false });
  });

  it('ends a regular expression that runs for ever at the time budget, keeping the hits found before it', async () => {
    put('a.txt', 'needle\n');
    put('z.txt', `${'a'.repeat(40)}!\n`);
    const started = Date.now();
    const result = await search({ query: 'needle|(a+)+$', regex: true, timeBudgetMs: 1_500 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.truncated).toBe(true);
    expect(result.hits.map((h) => h.path)).toContain('a.txt');
  });

  it('passes over a binary file (a NUL byte) and a file larger than the limit', async () => {
    put('bin.dat', Buffer.from('needle\0needle'));
    put('big.txt', Buffer.concat([Buffer.from('needle\n'), Buffer.alloc(CONTENT_SEARCH_MAX_FILE_BYTES, 0x61)]));
    put('ok.txt', 'needle\n');
    expect((await search()).hits.map((h) => h.path)).toEqual(['ok.txt']);
  });

  it('skips the excluded names at any depth, and the directories among them', async () => {
    put('node_modules/x/a.js', 'needle');
    put('src/.git/config', 'needle');
    put('src/keep.ts', 'needle');
    put('src/skip.log', 'needle');
    const { hits } = await search({ exclude: ['node_modules', '.git', '*.log'] });
    expect(hits.map((h) => h.path)).toEqual(['src/keep.ts']);
  });

  it('limits the files to the include globs: a name, or a path for a glob with a `/`', async () => {
    put('a.ts', 'needle');
    put('b.md', 'needle');
    put('src/c.ts', 'needle');
    put('lib/d.ts', 'needle');
    expect((await search({ include: ['*.md'] })).hits.map((h) => h.path)).toEqual(['b.md']);
    expect((await search({ include: ['src/*.ts'] })).hits.map((h) => h.path)).toEqual(['src/c.ts']);
    expect((await search({ include: ['*.md', 'lib/*'] })).hits.map((h) => h.path).sort()).toEqual(['b.md', 'lib/d.ts']);
  });

  it('gives at most 5 lines of a file, and stops at the hit limit saying it was cut', async () => {
    put('many.txt', Array.from({ length: 20 }, () => 'needle').join('\n'));
    expect((await search()).hits).toHaveLength(5);
    for (let i = 0; i < 5; i++) put(`f${i}.txt`, 'needle\nneedle\nneedle');
    const limited = await search({ maxHits: 7 });
    expect(limited.hits).toHaveLength(7);
    expect(limited.truncated).toBe(true);
  });

  it('reports a missing root as NOT_FOUND', async () => {
    await expect(ops.searchContent(path.join(dir, 'missing'), BASE)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('searchContent over the agent wire', () => {
  it('carries the query and the result through the request schema', async () => {
    put('a.txt', 'a needle\r\n');
    const remote = new RemoteFileOps(ops.platform, async (request) => {
      const body = await executeFileOp(ops, fileOpRequestSchema.parse(JSON.parse(JSON.stringify(request))));
      return JSON.parse(JSON.stringify(body));
    });
    const result = await remote.searchContent(dir, BASE);
    expect(result.hits).toMatchObject([{ path: 'a.txt', line: 1, text: 'a needle' }]);
  });

  it('bounds what a request may ask for', () => {
    const request = { op: 'searchContent', path: '/a', ...BASE };
    expect(fileOpRequestSchema.safeParse(request).success).toBe(true);
    expect(fileOpRequestSchema.safeParse({ ...request, query: '' }).success).toBe(false);
    expect(fileOpRequestSchema.safeParse({ ...request, maxHits: 0 }).success).toBe(false);
    expect(fileOpRequestSchema.safeParse({ ...request, timeBudgetMs: 60_000 }).success).toBe(false);
    expect(fileOpRequestSchema.safeParse({ ...request, include: undefined }).success).toBe(false);
  });

  it('keeps the refusal of the host as a FileOpsError', async () => {
    const remote = new RemoteFileOps(ops.platform, async (request) => JSON.parse(JSON.stringify(await executeFileOp(ops, fileOpRequestSchema.parse(request)))));
    await expect(remote.searchContent(path.join(dir, 'missing'), BASE)).rejects.toBeInstanceOf(FileOpsError);
  });
});

describe('what the hits are made of', () => {
  it('cuts a very long line to a window around the match, keeping the match inside it', async () => {
    put('long.txt', `${'x'.repeat(5000)}needle${'y'.repeat(5000)}\n`);
    const { hits } = await search();
    expect(hits).toHaveLength(1);
    expect(hits[0].text.length).toBe(CONTENT_SEARCH_MAX_LINE_CHARS);
    expect(hits[0].text.slice(hits[0].matchStart, hits[0].matchEnd)).toBe('needle');
    expect(hits[0].column).toBe(5001);
  });

  it('stops when the text of the hits reaches the size limit, saying the search was cut', async () => {
    // 3 bytes a character: 200 hits of 2000 characters would be more than the limit.
    const line = `needle${'あ'.repeat(1900)}\n`;
    for (let file = 0; file < 40; file++) put(`f${String(file).padStart(2, '0')}.txt`, line.repeat(5));
    const result = await search();
    expect(result.truncated).toBe(true);
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.length).toBeLessThan(200);
    expect(result.hits.reduce((sum, hit) => sum + Buffer.byteLength(hit.text), 0)).toBeLessThanOrEqual(CONTENT_SEARCH_MAX_RESULT_BYTES);
  });

  it('says it ran out of time', async () => {
    put('z.txt', `${'a'.repeat(40)}!\n`);
    const result = await search({ query: '(a+)+$', regex: true, timeBudgetMs: 1_000 });
    expect(result).toMatchObject({ hits: [], truncated: true, timedOut: true });
  });
});

describe('files with a byte order mark', () => {
  const body = 'first line\nneedle second\r\nlast';

  it('removes the mark of UTF-8 from the first line, so the position of a match in it is right', async () => {
    put('bom8.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('needle first\nx\n')]));
    const { hits } = await search({ query: '^needle', regex: true });
    expect(hits).toMatchObject([{ path: 'bom8.txt', line: 1, column: 1, text: 'needle first' }]);
  });

  it('reads UTF-16 with a mark, little-endian and big-endian, as text', async () => {
    put('le.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')]));
    put('be.txt', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(body, 'utf16le').swap16()]));
    const { hits } = await search();
    expect(hits.map((h) => [h.path, h.line, h.column, h.text])).toEqual([['be.txt', 2, 1, 'needle second'], ['le.txt', 2, 1, 'needle second']]);
  });

  it('still takes UTF-16 without a mark for a binary file', async () => {
    put('nomark.txt', Buffer.from('needle', 'utf16le'));
    expect((await search()).hits).toEqual([]);
  });
});

describe('globs as ripgrep reads them', () => {
  function tree(): void {
    put('a.ts', 'needle');
    put('notes.md', 'needle');
    put('src/b.ts', 'needle');
    put('src/deep/c.ts', 'needle');
    put('src/deep/er/d.ts', 'needle');
    put('src/private/key.ts', 'needle');
    put('src/private/nested/key2.ts', 'needle');
    put('lib/src/e.ts', 'needle');
    put('lib/private/f.ts', 'needle');
    put('src/gen/g.ts', 'needle');
  }

  const found = async (overrides: Partial<ContentSearchOptions>): Promise<string[]> => (await search(overrides)).hits.map((h) => h.path).sort();

  it('leaves out everything below a directory with a path glob, and a name glob at any depth', async () => {
    tree();
    expect(await found({ exclude: ['src/private/**'] })).not.toContain('src/private/key.ts');
    expect(await found({ exclude: ['src/private/**'] })).not.toContain('src/private/nested/key2.ts');
    expect(await found({ exclude: ['src/private/**'] })).toContain('lib/private/f.ts');
    expect(await found({ exclude: ['private'] })).toEqual(expect.not.arrayContaining(['src/private/key.ts', 'lib/private/f.ts']));
    expect(await found({ exclude: ['/lib'] })).toEqual(expect.not.arrayContaining(['lib/src/e.ts']));
    expect(await found({ exclude: ['src/gen/'] })).not.toContain('src/gen/g.ts');
  });

  it('keeps `src/*.ts` to the files directly in the src directory of the root', async () => {
    tree();
    expect(await found({ include: ['src/*.ts'] })).toEqual(['src/b.ts']);
    expect(await found({ include: ['src/**/*.ts'] })).toEqual(['src/b.ts', 'src/deep/c.ts', 'src/deep/er/d.ts', 'src/gen/g.ts', 'src/private/key.ts', 'src/private/nested/key2.ts']);
    expect(await found({ include: ['*.md', 'src/deep/*.ts'] })).toEqual(['notes.md', 'src/deep/c.ts']);
  });

  /** ripgrep itself as the reference: the same tree, the same globs. Where it is not installed there is nothing to compare with. */
  const rgInstalled = ((): boolean => {
    try {
      execFileSync('rg', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!rgInstalled || process.platform === 'win32')('finds the same files as rg -g does', async () => {
    tree();
    const cases: Array<{ include?: string[]; exclude?: string[] }> = [
      { include: ['src/*.ts'] },
      { include: ['*.md'] },
      { include: ['src/**/*.ts'] },
      { include: ['src/deep/*.ts'] },
      { exclude: ['src/private/**'] },
      { exclude: ['private'] },
      { exclude: ['/lib'] },
      { exclude: ['src/gen/'] },
      { exclude: ['*.md', 'src/deep/**'] },
      { include: ['*.ts'], exclude: ['src/private/**'] },
    ];
    for (const { include = [], exclude = [] } of cases) {
      const globs = [...include.flatMap((g) => ['-g', g]), ...exclude.flatMap((g) => ['-g', `!${g}`])];
      let listed = '';
      try {
        listed = execFileSync('rg', ['-l', '-F', '--no-ignore', '--hidden', ...globs, '--', 'needle', '.'], { cwd: dir, encoding: 'utf8' });
      } catch (err) {
        // exit code 1: no file matches
        if ((err as { status?: number }).status !== 1) throw err;
      }
      const expected = listed.split('\n').filter(Boolean).map((p) => p.replace(/^\.\//, '')).sort();
      expect(await found({ include, exclude }), JSON.stringify({ include, exclude })).toEqual(expected);
    }
  });
});

describe('a file that is replaced after the walk', () => {
  const OUTSIDE = 'secret needle outside the root\n';
  const scan = async (files: Array<{ absolute: string; relative: string }>) => scanFilesForContent(dir, files, BASE, 5_000);

  it.skipIf(process.platform === 'win32')('does not read a file that has become a symbolic link out of the root', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'azito-outside-'));
    try {
      writeFileSync(path.join(outside, 'secret.txt'), OUTSIDE);
      put('ok.txt', 'needle\n');
      symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'swapped.txt'));
      const result = await scan([{ absolute: path.join(dir, 'swapped.txt'), relative: 'swapped.txt' }, { absolute: path.join(dir, 'ok.txt'), relative: 'ok.txt' }]);
      expect(result.hits.map((h) => h.path)).toEqual(['ok.txt']);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('does not read through a directory that has become a link out of the root', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'azito-outside-'));
    try {
      writeFileSync(path.join(outside, 'secret.txt'), OUTSIDE);
      symlinkSync(outside, path.join(dir, 'swappedDir'), 'dir');
      const result = await scan([{ absolute: path.join(dir, 'swappedDir', 'secret.txt'), relative: 'swappedDir/secret.txt' }]);
      expect(result.hits).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('does not read a directory as a file', async () => {
    mkdirSync(path.join(dir, 'now-a-directory'));
    expect((await scan([{ absolute: path.join(dir, 'now-a-directory'), relative: 'now-a-directory' }])).hits).toEqual([]);
  });
});

describe('the handle that was opened is the file that was checked', () => {
  it.skipIf(process.platform === 'win32')('does not read a file outside the root when the directory is put back between the open and the check', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'azito-outside-'));
    try {
      writeFileSync(path.join(outside, 'secret.txt'), 'needle outside the root\n');
      put('dreal/secret.txt', 'needle decoy inside the root\n');
      symlinkSync(outside, path.join(dir, 'd'), 'dir');
      // The path `d/secret.txt` opens the outside file; then `d` becomes the real directory, so the path checks out as inside.
      const result = await scanFilesForContent(dir, [{ absolute: path.join(dir, 'd', 'secret.txt'), relative: 'd/secret.txt' }], BASE, 5_000, {
        afterOpen: [{ op: 'unlink', args: [path.join(dir, 'd')] }, { op: 'rename', args: [path.join(dir, 'dreal'), path.join(dir, 'd')] }],
      });
      expect(result.hits).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('reads an ordinary file through the same checks (so a file index is reported on this OS)', async () => {
    put('plain.txt', 'needle\n');
    const result = await scanFilesForContent(dir, [{ absolute: path.join(dir, 'plain.txt'), relative: 'plain.txt' }], BASE, 5_000);
    expect(result.hits.map((h) => h.path)).toEqual(['plain.txt']);
  });
});

describe('the size limit counts what is sent', () => {
  it('counts the JSON escapes of control characters, so the whole response stays within the limit', async () => {
    const line = `needle${'\u0001'.repeat(1000)}\n`;
    for (let file = 0; file < 40; file++) put(`c${String(file).padStart(2, '0')}.txt`, line.repeat(5));
    const result = await search();
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.hits))).toBeLessThanOrEqual(CONTENT_SEARCH_MAX_RESULT_BYTES);
  });
});
