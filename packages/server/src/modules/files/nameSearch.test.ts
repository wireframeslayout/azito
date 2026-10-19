import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { LocalFileOps, localFileOpsHost } from '../../shared/fs/LocalFileOps';
import { FileOpsError, type DirEntry, type IFileOps } from '../../shared/fs/fileOps';
import { globToRegExp, NameSearchTimeoutError, searchFileNames, type NameSearchQuery } from './nameSearch';

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
const LIMITS = { maxResults: 200, deadlineMs: Date.now() + 60_000 };

function search(overrides: Partial<NameSearchQuery> = {}, limits = LIMITS): Promise<string[]> {
  return searchFileNames(ops, { root, query: 'test', caseSensitive: false, regex: false, include: [], excludeNames: EXCLUDED, ...overrides }, limits);
}

describe('globToRegExp', () => {
  it('reads * ? and [set] as find -name does, and everything else literally', () => {
    expect(globToRegExp('*.ts', true).test('a.b.ts')).toBe(true);
    expect(globToRegExp('*.ts', true).test('a.tsx')).toBe(false);
    expect(globToRegExp('a?c', true).test('abc')).toBe(true);
    expect(globToRegExp('a?c', true).test('ac')).toBe(false);
    expect(globToRegExp('[ab]x', true).test('bx')).toBe(true);
    expect(globToRegExp('[!ab]x', true).test('bx')).toBe(false);
    expect(globToRegExp('[!ab]x', true).test('cx')).toBe(true);
    expect(globToRegExp('a.b(c)+', true).test('a.b(c)+')).toBe(true);
    expect(globToRegExp('a.b(c)+', true).test('aXb(c)+')).toBe(false);
    expect(globToRegExp('a\\*b', true).test('a*b')).toBe(true);
    expect(globToRegExp('a\\*b', true).test('axb')).toBe(false);
    expect(globToRegExp('[x', true).test('[x')).toBe(true);
  });

  it('lets * cross a slash (find -path) and honors case', () => {
    expect(globToRegExp('*/src/*.ts', true).test('/p/src/a.ts')).toBe(true);
    expect(globToRegExp('abc', true).test('ABC')).toBe(false);
    expect(globToRegExp('abc', false).test('ABC')).toBe(true);
  });
});

describe('searchFileNames', () => {
  it('finds files whose name contains the query, at any depth, as paths relative to the root', async () => {
    tree('src/test.ts', 'src/deep/er/my-test.spec.ts', 'readme.md', 'src/other.ts');

    // shallower first, then by name
    expect(await search()).toEqual(['src/test.ts', 'src/deep/er/my-test.spec.ts']);
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

      expect(await search({ regex: true, query: '(' })).toEqual([]);
    });
  });

  describe('limits', () => {
    it('stops at maxResults', async () => {
      tree(...Array.from({ length: 30 }, (_, i) => `d${i % 3}/test${i}.ts`));

      expect(await search({}, { ...LIMITS, maxResults: 7 })).toHaveLength(7);
    });

    it('fails with NameSearchTimeoutError once the deadline has passed', async () => {
      tree('a/test.ts');

      await expect(search({}, { maxResults: 200, deadlineMs: Date.now() - 1 })).rejects.toBeInstanceOf(NameSearchTimeoutError);
    });
  });

  describe('failures', () => {
    it('passes over a directory the host refuses to list, and finds nothing under a missing root', async () => {
      const listing = (dir: string): DirEntry[] => (dir === '/r' ? [{ name: 'locked', kind: 'directory' }, { name: 'test.ts', kind: 'file', size: 1 }] : []);
      const refusing = {
        platform: 'linux',
        list: async (dir: string): Promise<DirEntry[]> => {
          if (dir === '/r/locked') throw new FileOpsError('PERMISSION_DENIED', 'no');
          return listing(dir);
        },
      } as unknown as IFileOps;

      expect(await searchFileNames(refusing, { root: '/r', query: 'test', caseSensitive: false, regex: false, include: [], excludeNames: [] }, LIMITS)).toEqual(['test.ts']);
      expect(await search({ root: path.join(root, 'missing') })).toEqual([]);
    });

    it('lets a failure that is not a refusal of the host propagate', async () => {
      const unreachable = {
        platform: 'linux',
        list: async (): Promise<DirEntry[]> => { throw new Error('agent unreachable'); },
      } as unknown as IFileOps;

      await expect(searchFileNames(unreachable, { root: '/r', query: 'a', caseSensitive: false, regex: false, include: [], excludeNames: [] }, LIMITS)).rejects.toThrow('agent unreachable');
    });
  });
});
