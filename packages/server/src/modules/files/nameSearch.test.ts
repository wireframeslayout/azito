import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { LocalFileOps, localFileOpsHost } from '../../shared/fs/LocalFileOps';
import { FileOpsError, type IFileOps, type WalkResult } from '../../shared/fs/fileOps';
import { searchFileNames, type NameSearchQuery, type NameSearchResult } from './nameSearch';

let root: string;
let ops: LocalFileOps;

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'azito-namesearch-')));
  ops = new LocalFileOps(localFileOpsHost({ platform: process.platform, homeDir: root }));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function tree(...files: string[]): void {
  for (const file of files) {
    const full = path.join(root, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, '');
  }
}

const EXCLUDED = ['node_modules', '.git', 'dist', '.worktrees'];
const LIMITS = { maxResults: 200, budgetMs: 30_000 };

function searchResult(overrides: Partial<NameSearchQuery> = {}, limits = LIMITS, files: IFileOps = ops): Promise<NameSearchResult> {
  return searchFileNames(files, { root, query: 'test', caseSensitive: false, regex: false, include: [], excludeNames: EXCLUDED, ...overrides }, limits);
}

async function search(overrides: Partial<NameSearchQuery> = {}, limits = LIMITS): Promise<string[]> {
  return (await searchResult(overrides, limits)).paths;
}

/** A host whose walk is `walk`: only what the search makes of it is under test. */
function hostWalking(walk: IFileOps['walk']): IFileOps {
  return { platform: 'linux', walk } as unknown as IFileOps;
}

describe('searchFileNames', () => {
  it('drops a trailing backslash of a Windows root before it joins the path, so the text matched has one separator', async () => {
    const files = hostWalking(async () => ({ entries: [{ path: 'src/a.ts', mtimeMs: 1 }], truncated: false }));
    const found = await searchResult({ root: 'C:\\proj\\', regex: true, query: 'C:.proj/src/a\\.ts', include: ['src/*.ts'] }, LIMITS, files);
    expect(found.paths).toEqual(['src/a.ts']);
  });

  it('finds files whose name contains the query, at any depth, as paths relative to the root', async () => {
    tree('src/test.ts', 'src/deep/er/my-test.spec.ts', 'readme.md', 'src/other.ts');

    // shallower first, then by name
    expect(await search()).toEqual(['src/test.ts', 'src/deep/er/my-test.spec.ts']);
  });

  it('puts a host\'s walk order (find\'s) into shallower first, then by name', async () => {
    const found = await searchResult({}, LIMITS, hostWalking(async () => ({
      entries: [{ path: 'b/deep/test.ts', mtimeMs: 1 }, { path: 'z/test.ts', mtimeMs: 1 }, { path: 'test.ts', mtimeMs: 1 }, { path: 'a/test.ts', mtimeMs: 1 }],
      truncated: false,
    })));

    expect(found.paths).toEqual(['test.ts', 'a/test.ts', 'z/test.ts', 'b/deep/test.ts']);
  });

  it('is case-insensitive unless asked otherwise', async () => {
    // in separate directories: a Windows filesystem would treat the two names as one file
    tree('upper/Test.ts', 'lower/test.ts');

    expect(await search()).toEqual(['lower/test.ts', 'upper/Test.ts']);
    expect(await search({ caseSensitive: true })).toEqual(['lower/test.ts']);
  });

  it('reads the query as a glob, as find -iname does', async () => {
    tree('a.test.ts', 'a.test.js');

    expect(await search({ query: '*.ts' })).toEqual(['a.test.ts']);
  });

  it('never lists a directory, and does not follow symbolic links', async () => {
    tree('test-dir/inner.txt', 'real/test.txt');
    if (process.platform !== 'win32') {
      symlinkSync(path.join(root, 'real'), path.join(root, 'test-link'));
      symlinkSync(path.join(root, 'real', 'test.txt'), path.join(root, 'test-file-link'));
    }

    expect(await search()).toEqual(['real/test.txt']);
  });

  it('does not enter or list an excluded name, wherever it is', async () => {
    tree('node_modules/pkg/test.js', '.git/test', 'a/dist/test.js', 'a/.worktrees/x/test.ts', 'keep/test.ts', 'vendor/test.ts');

    expect(await search()).toEqual(['keep/test.ts', 'vendor/test.ts']);
    expect(await search({ excludeNames: [...EXCLUDED, 'vendor'] })).toEqual(['keep/test.ts']);
    expect(await search({ excludeNames: [...EXCLUDED, 'v*'] })).toEqual(['keep/test.ts']);
  });

  describe('include', () => {
    it('keeps files matching a name glob, or a path glob when it has a slash', async () => {
      tree('a/test.ts', 'a/test.js', 'b/test.ts', 'b/test.tsx');

      expect(await search({ include: ['*.ts'] })).toEqual(['a/test.ts', 'b/test.ts']);
      expect(await search({ include: ['a/*'] })).toEqual(['a/test.js', 'a/test.ts']);
      expect(await search({ include: ['*.js', 'b/*.tsx'] })).toEqual(['a/test.js', 'b/test.tsx']);
    });
  });

  describe('regex', () => {
    it('must match the whole path (root included), like find -regex', async () => {
      tree('src/a.test.ts', 'src/b.ts', 'c.test.ts');

      expect(await search({ regex: true, query: '.*\\.test\\.ts$' })).toEqual(['c.test.ts', 'src/a.test.ts']);
      expect(await search({ regex: true, query: '\\.test\\.ts$' })).toEqual([]);
      expect(await search({ regex: true, query: `${root.replace(/[\\.*+?^${}()|[\]]/g, '\\$&')}/src/.*` })).toEqual(['src/a.test.ts', 'src/b.ts']);
    });

    it('honors case sensitivity', async () => {
      tree('Readme.MD');

      expect(await search({ regex: true, query: '.*readme\\.md' })).toEqual(['Readme.MD']);
      expect(await search({ regex: true, query: '.*readme\\.md', caseSensitive: true })).toEqual([]);
    });

    it('finds nothing for an expression that cannot be compiled', async () => {
      tree('a.ts');

      expect(await searchResult({ regex: true, query: '(' })).toEqual({ paths: [], truncated: false });
    });

    it('is stopped by the deadline when the expression would run for ever, and says the search is truncated', async () => {
      tree(`${'a'.repeat(40)}!.txt`, 'b.txt');
      const started = Date.now();

      const found = await searchResult({ regex: true, query: '.*(a+)+$' }, { maxResults: 200, budgetMs: 2_500 });

      expect(Date.now() - started).toBeLessThan(5_000);
      expect(found.truncated).toBe(true);
    });

    it('stops at maxResults', async () => {
      tree(...Array.from({ length: 20 }, (_, i) => `f${i}.ts`));

      expect((await searchResult({ regex: true, query: '.*\\.ts' }, { maxResults: 3, budgetMs: 30_000 })).paths).toHaveLength(3);
    });
  });

  describe('glob patterns of a user', () => {
    it('cannot be made to run for ever: many stars against a long name finish at once', async () => {
      tree(`${'a'.repeat(60)}.txt`);
      const started = Date.now();

      expect(await search({ query: '*a*a*a*a*a*a*a*a*a*a*b' })).toEqual([]);

      expect(Date.now() - started).toBeLessThan(2_000);
    });
  });

  describe('limits', () => {
    it('stops at maxResults', async () => {
      tree(...Array.from({ length: 30 }, (_, i) => `d${i % 3}/test${i}.ts`));

      expect(await search({}, { ...LIMITS, maxResults: 7 })).toHaveLength(7);
    });

    it('reports a walk that reached its bound as truncated, and keeps what it found', async () => {
      const found = await searchResult({}, LIMITS, hostWalking(async (): Promise<WalkResult> => ({ entries: [{ path: 'test.ts', mtimeMs: 1 }], truncated: true })));

      expect(found).toEqual({ paths: ['test.ts'], truncated: true });
    });

    it('returns truncated with nothing instead of waiting for a host that does not answer', async () => {
      const started = Date.now();

      const found = await searchResult({}, { maxResults: 200, budgetMs: 200 }, hostWalking(() => new Promise<WalkResult>(() => undefined)));

      expect(found).toEqual({ paths: [], truncated: true });
      expect(Date.now() - started).toBeLessThan(2_000);
    });

    it('asks the host to walk within the budget, leaving room for the answer', async () => {
      let asked: Parameters<IFileOps['walk']>[1] | undefined;
      await searchResult({}, { maxResults: 200, budgetMs: 10_000 }, hostWalking(async (_root, options) => { asked = options; return { entries: [], truncated: false }; }));

      expect(asked?.timeBudgetMs).toBeLessThan(10_000);
      expect(asked?.excludeNames).toEqual(EXCLUDED);
    });
  });

  describe('failures', () => {
    it('finds nothing under a missing or unreadable root', async () => {
      expect(await search({ root: path.join(root, 'missing') })).toEqual([]);
      const locked = hostWalking(async () => { throw new FileOpsError('PERMISSION_DENIED', 'no'); });
      expect(await searchResult({}, LIMITS, locked)).toEqual({ paths: [], truncated: false });
    });

    it('lets a failure that is not a refusal of the host propagate', async () => {
      const unreachable = hostWalking(async () => { throw new Error('agent unreachable'); });

      await expect(searchResult({}, LIMITS, unreachable)).rejects.toThrow('agent unreachable');
    });
  });
});
