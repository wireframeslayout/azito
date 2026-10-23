import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { LocalFileOps, localFileOpsHost } from '../../shared/fs/LocalFileOps';
import type { IFileOps } from '../../shared/fs/fileOps';
import { DeadlineExceededError } from '../../shared/fs/deadline';
import { findFilesByMtime, firstLineOf, normalizePath, parseRolloutMeta } from './sessionScanUtils';

let dir: string;
let ops: LocalFileOps;

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'azito-scan-')));
  ops = new LocalFileOps(localFileOpsHost({ platform: process.platform, homeDir: dir }));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function touch(relative: string, mtimeSeconds: number): string {
  const full = path.join(dir, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, 'x');
  utimesSync(full, mtimeSeconds, mtimeSeconds);
  return full;
}

const jsonl = (name: string): boolean => name.endsWith('.jsonl');
const soon = (): number => Date.now() + 30_000;

describe('findFilesByMtime', () => {
  it('finds matching files at any depth, oldest first, and ignores other names and directories', async () => {
    const newest = touch('2026/07/15/c.jsonl', 3000);
    const oldest = touch('a.jsonl', 1000);
    const middle = touch('2026/b.jsonl', 2000);
    touch('2026/notes.txt', 2500);
    mkdirSync(path.join(dir, 'looks-like.jsonl'));

    const found = await findFilesByMtime(ops, dir, jsonl, undefined, soon());

    expect(found).toEqual([
      { path: oldest, mtimeMs: 1_000_000 },
      { path: middle, mtimeMs: 2_000_000 },
      { path: newest, mtimeMs: 3_000_000 },
    ]);
  });

  it('keeps only files strictly newer than the timestamp, which counts in whole seconds (find -newermt @N)', async () => {
    const same = touch('same.jsonl', 2000);
    const newer = touch('newer.jsonl', 2001);
    touch('older.jsonl', 1999);

    const found = await findFilesByMtime(ops, dir, jsonl, new Date(2_000_900), soon());

    expect(found.map((f) => f.path)).toEqual([newer]);
    expect(found.map((f) => f.path)).not.toContain(same);
  });

  it('yields nothing for a directory that does not exist', async () => {
    await expect(findFilesByMtime(ops, path.join(dir, 'missing'), jsonl, undefined, soon())).resolves.toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('does not follow a symbolic link to a file or a directory', async () => {
    const real = touch('real/a.jsonl', 1000);
    symlinkSync(real, path.join(dir, 'link.jsonl'));
    symlinkSync(path.join(dir, 'real'), path.join(dir, 'linked-dir'));

    expect((await findFilesByMtime(ops, dir, jsonl, undefined, soon())).map((f) => f.path)).toEqual([real]);
  });

  it('is an error, not a guess from part of the tree, when the walk did not see all of it', async () => {
    const partial = { platform: 'linux', walk: async () => ({ entries: [{ path: 'a.jsonl', mtimeMs: 1 }], truncated: true }) } as unknown as IFileOps;

    await expect(findFilesByMtime(partial, '/x', jsonl, undefined, soon())).rejects.toBeInstanceOf(DeadlineExceededError);
  });

  it('is an error when the host does not answer before the deadline', async () => {
    const silent = { platform: 'linux', walk: () => new Promise(() => undefined) } as unknown as IFileOps;

    await expect(findFilesByMtime(silent, '/x', jsonl, undefined, Date.now() + 50)).rejects.toBeInstanceOf(DeadlineExceededError);
  });

  it('asks the host to walk within the time that is left', async () => {
    let asked: { timeBudgetMs: number } | undefined;
    const host = { platform: 'linux', walk: async (_root: string, options: { timeBudgetMs: number }) => { asked = options; return { entries: [], truncated: false }; } } as unknown as IFileOps;

    await findFilesByMtime(host, '/x', jsonl, undefined, Date.now() + 5_000);

    expect(asked!.timeBudgetMs).toBeLessThanOrEqual(5_000);
    expect(asked!.timeBudgetMs).toBeGreaterThan(0);
  });

  it('lets a failure that is not a refusal of the host propagate', async () => {
    const unreachable = { platform: 'linux', walk: async () => { throw new Error('agent unreachable'); } } as unknown as IFileOps;

    await expect(findFilesByMtime(unreachable, '/x', jsonl, undefined, soon())).rejects.toThrow('agent unreachable');
  });
});

describe('firstLineOf', () => {
  it('returns the text up to the first line break, or all of it without one', () => {
    expect(firstLineOf(Buffer.from('one\ntwo\n'))).toBe('one');
    expect(firstLineOf(Buffer.from('only line'))).toBe('only line');
  });

  it('is null for an empty file or one that starts with a line break', () => {
    expect(firstLineOf(Buffer.alloc(0))).toBeNull();
    expect(firstLineOf(Buffer.from('\nsecond'))).toBeNull();
  });
});

describe('parseRolloutMeta', () => {
  it('parses session metadata', () => {
    expect(parseRolloutMeta('/tmp/old.jsonl', '{"type":"session_meta","payload":{"session_id":"old","cwd":"/work/","originator":"codex"}}')).toEqual(
      { filePath: '/tmp/old.jsonl', sessionId: 'old', cwd: '/work/', originator: 'codex' },
    );
  });

  it('allows absent cwd and originator values', () => {
    expect(parseRolloutMeta('/tmp/session.jsonl', '{"payload":{"session_id":"session"}}')).toEqual(
      { filePath: '/tmp/session.jsonl', sessionId: 'session', cwd: null, originator: null },
    );
  });

  it('is null for a line that is not JSON, has no payload, or has no session id', () => {
    expect(parseRolloutMeta('/tmp/bad.jsonl', 'not json')).toBeNull();
    expect(parseRolloutMeta('/tmp/bad.jsonl', '"a string"')).toBeNull();
    expect(parseRolloutMeta('/tmp/bad.jsonl', '{"type":"x"}')).toBeNull();
    expect(parseRolloutMeta('/tmp/missing.jsonl', '{"type":"session_meta","payload":{"cwd":"/work"}}')).toBeNull();
  });
});

describe('normalizePath', () => {
  it('removes trailing slashes', () => {
    expect(normalizePath('/work/project///')).toBe('/work/project');
    expect(normalizePath('/work/project')).toBe('/work/project');
  });
});
