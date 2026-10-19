import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { LocalFileOps, localFileOpsHost } from '../../shared/fs/LocalFileOps';
import type { DirEntry, IFileOps } from '../../shared/fs/fileOps';
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

describe('findFilesByMtime', () => {
  it('finds matching files at any depth, oldest first, and ignores other names and directories', async () => {
    const newest = touch('2026/07/15/c.jsonl', 3000);
    const oldest = touch('a.jsonl', 1000);
    const middle = touch('2026/b.jsonl', 2000);
    touch('2026/notes.txt', 2500);
    mkdirSync(path.join(dir, 'looks-like.jsonl'));

    const found = await findFilesByMtime(ops, dir, jsonl);

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

    const found = await findFilesByMtime(ops, dir, jsonl, new Date(2_000_900));

    expect(found.map((f) => f.path)).toEqual([newer]);
    expect(found.map((f) => f.path)).not.toContain(same);
  });

  it('yields nothing for a directory that does not exist', async () => {
    await expect(findFilesByMtime(ops, path.join(dir, 'missing'), jsonl)).resolves.toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('does not follow a symbolic link to a file or a directory', async () => {
    const real = touch('real/a.jsonl', 1000);
    symlinkSync(real, path.join(dir, 'link.jsonl'));
    symlinkSync(path.join(dir, 'real'), path.join(dir, 'linked-dir'));

    expect((await findFilesByMtime(ops, dir, jsonl)).map((f) => f.path)).toEqual([real]);
  });

  it('fails when the host lists a file without a modification time (an outdated agent) instead of ordering it by a guess', async () => {
    const outdated = {
      platform: 'linux',
      list: async (): Promise<DirEntry[]> => [{ name: 'a.jsonl', kind: 'file', size: 1 }],
    } as unknown as IFileOps;

    await expect(findFilesByMtime(outdated, '/x', jsonl)).rejects.toThrow(/modification time/);
  });

  it('lets a failure that is not a refusal of the host propagate', async () => {
    const unreachable = {
      platform: 'linux',
      list: async (): Promise<DirEntry[]> => { throw new Error('agent unreachable'); },
    } as unknown as IFileOps;

    await expect(findFilesByMtime(unreachable, '/x', jsonl)).rejects.toThrow('agent unreachable');
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
