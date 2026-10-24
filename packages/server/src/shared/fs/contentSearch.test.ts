import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { CONTENT_SEARCH_MAX_FILE_BYTES, FileOpsError, type ContentSearchOptions } from './fileOps';
import { executeFileOp, fileOpRequestSchema, RemoteFileOps } from './fileOpsWire';
import { LocalFileOps, localFileOpsHost } from './LocalFileOps';

let dir: string;
let ops: LocalFileOps;

const BASE: ContentSearchOptions = {
  query: 'needle', caseSensitive: false, wholeWord: false, regex: false, include: [], excludeNames: [], maxHits: 200, timeBudgetMs: 10_000,
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
    expect(await search({ query: '(', regex: true })).toEqual({ hits: [], truncated: false });
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
    const { hits } = await search({ excludeNames: ['node_modules', '.git', '*.log'] });
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
