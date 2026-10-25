import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyHubFolders, pruneHubVersions } from '../windowsHubPrune';

const noneInUse = async (): Promise<ReadonlySet<string>> => new Set();

describe('classifyHubFolders (what stays and what goes)', () => {
  const names = ['v0.1.0', 'v0.2.0', 'v0.3.0', 'v0.4.0', '.staging-abc', '.env', 'current.txt', 'logs', 'v0.5.0.bak.old', 'not-a-version'];

  it('keeps the current version, the one before and the ones in use, and removes the other version-named folders', () => {
    const result = classifyHubFolders(names, { current: 'v0.4.0', previous: 'v0.3.0', inUse: new Set(['v0.1.0']) });
    expect(result.remove).toEqual(['v0.2.0']);
    expect(result.keep).toEqual([
      { name: 'v0.1.0', why: 'in use' },
      { name: 'v0.3.0', why: 'previous' },
      { name: 'v0.4.0', why: 'current' },
    ]);
  });

  it('never lists a name that is not shaped like a version, whatever else is true of it', () => {
    const result = classifyHubFolders(names, { current: 'v0.4.0', previous: 'v0.3.0', inUse: new Set() });
    const listed = [...result.remove, ...result.keep.map((k) => k.name)];
    for (const other of ['.staging-abc', '.env', 'current.txt', 'logs', 'not-a-version', 'v0.5.0.bak.old']) expect(listed).not.toContain(other);
  });

  it('compares versions without regard to case, as the file system does', () => {
    const result = classifyHubFolders(['v0.1.0-RC.1', 'v0.2.0', 'v0.3.0'], { current: 'v0.3.0', previous: 'v0.2.0', inUse: new Set(['v0.1.0-rc.1']) });
    expect(result.remove).toEqual([]);
    expect(result.keep.find((k) => k.name === 'v0.1.0-RC.1')?.why).toBe('in use');
  });

  it('removes a prerelease folder that nothing needs', () => {
    expect(classifyHubFolders(['v0.12.0-rc.1', 'v0.12.0'], { current: 'v0.12.0', previous: 'v0.11.2', inUse: new Set() }).remove).toEqual(['v0.12.0-rc.1']);
  });
});

describe('pruneHubVersions', () => {
  let root: string;
  let hub: string;
  let outside: string;

  const folder = (name: string, files: Record<string, string> = { 'azito-hub.cjs': 'x', 'sub/deep.txt': 'y' }): string => {
    const dir = path.join(hub, name);
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    return dir;
  };
  const removeByDeleting = async (name: string): Promise<void> => { fs.rmSync(path.join(hub, name), { recursive: true }); };
  const removeIsolated = vi.fn(removeByDeleting);
  const prune = (current = 'v0.4.0', previous = 'v0.3.0', versionsInUse = noneInUse) => pruneHubVersions({ hubDir: hub, current, previous, versionsInUse, removeIsolated });

  beforeEach(() => {
    removeIsolated.mockReset().mockImplementation(removeByDeleting);
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'azito-prune-')));
    hub = path.join(root, 'hub');
    outside = path.join(root, 'outside');
    fs.mkdirSync(hub);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('removes the old version folders and leaves the current one, the one before and everything that is not shaped like a version', async () => {
    for (const name of ['v0.1.0', 'v0.2.0', 'v0.3.0', 'v0.4.0', '.staging-abc', 'logs']) folder(name);
    fs.writeFileSync(path.join(hub, 'current.txt'), 'v0.4.0\r\n');
    const report = await prune();
    expect(report).toEqual({ removed: ['v0.1.0', 'v0.2.0'], failed: [], skipped: [] });
    expect(fs.readdirSync(hub).sort()).toEqual(['.staging-abc', 'current.txt', 'logs', 'v0.3.0', 'v0.4.0']);
    expect(fs.existsSync(path.join(hub, '.staging-abc', 'sub', 'deep.txt'))).toBe(true);
  });

  it('does not even ask which versions are in use when there is nothing to remove', async () => {
    folder('v0.3.0');
    folder('v0.4.0');
    const versionsInUse = vi.fn(noneInUse);
    expect(await prune('v0.4.0', 'v0.3.0', versionsInUse)).toEqual({ removed: [], failed: [], skipped: [] });
    expect(versionsInUse).not.toHaveBeenCalled();
  });

  it('keeps a version a running process uses, and reports it so that the next update tries again', async () => {
    folder('v0.1.0');
    folder('v0.2.0');
    const report = await prune('v0.4.0', 'v0.3.0', async () => new Set(['v0.1.0']));
    expect(report.removed).toEqual(['v0.2.0']);
    expect(report.failed).toEqual([{ name: 'v0.1.0', reason: 'a running process uses it' }]);
    expect(fs.existsSync(path.join(hub, 'v0.1.0', 'azito-hub.cjs'))).toBe(true);
    // The next update, when nothing uses it any more:
    expect((await prune()).removed).toEqual(['v0.1.0']);
  });

  it('removes nothing when it cannot tell which versions are in use', async () => {
    folder('v0.1.0');
    await expect(prune('v0.4.0', 'v0.3.0', async () => { throw new Error('cannot list processes'); })).rejects.toThrow(/cannot list processes/);
    expect(fs.existsSync(path.join(hub, 'v0.1.0', 'azito-hub.cjs'))).toBe(true);
  });

  it('leaves a link named like a version alone: it is not followed, not removed, and reported as skipped', async () => {
    fs.symlinkSync(outside, path.join(hub, 'v0.1.0'), 'junction');
    folder('v0.2.0');
    const report = await prune();
    expect(report.removed).toEqual(['v0.2.0']);
    expect(report.skipped).toEqual([{ name: 'v0.1.0', reason: expect.stringMatching(/link/) }]);
    expect(fs.lstatSync(path.join(hub, 'v0.1.0')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf-8')).toBe('keep me');
  });

  it('sets a folder aside as .prune-<tag>-<random> before it is removed, and removes only that', async () => {
    folder('v0.1.0');
    const seen: string[] = [];
    removeIsolated.mockImplementation(async (name: string) => {
      seen.push(name);
      expect(fs.existsSync(path.join(hub, 'v0.1.0'))).toBe(false);
      fs.rmSync(path.join(hub, name), { recursive: true });
    });
    expect(await prune()).toEqual({ removed: ['v0.1.0'], failed: [], skipped: [] });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^\.prune-v0\.1\.0-[0-9a-f]{8}$/);
  });

  it('keeps what could not be removed under its .prune name, reports it, and removes it in the next round', async () => {
    folder('v0.1.0');
    removeIsolated.mockRejectedValueOnce(new Error('rd could not remove (exit 1)'));
    const first = await prune();
    expect(first.removed).toEqual([]);
    expect(first.failed).toEqual([{ name: 'v0.1.0', reason: expect.stringMatching(/rd could not remove.*left as \.prune-v0\.1\.0-[0-9a-f]{8}; the next update removes it/) }]);
    expect(fs.readdirSync(hub)).toHaveLength(1);
    const second = await prune();
    expect(second.removed).toHaveLength(1);
    expect(fs.readdirSync(hub)).toEqual([]);
  });

  it('a folder that cannot be set aside stays where it was, and is reported', async () => {
    folder('v0.1.0');
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw Object.assign(new Error('access denied'), { code: 'EACCES' }); });
    try {
      const report = await prune();
      expect(report.failed).toEqual([{ name: 'v0.1.0', reason: expect.stringMatching(/could not be set aside.*EACCES/) }]);
    } finally {
      rename.mockRestore();
    }
    expect(removeIsolated).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(hub, 'v0.1.0', 'azito-hub.cjs'))).toBe(true);
  });

  it('a link left as .prune-* is not ours to remove, and a real one is picked up', async () => {
    fs.symlinkSync(outside, path.join(hub, '.prune-v0.1.0-0123abcd'), 'junction');
    folder('.prune-v0.2.0-4567cdef');
    const report = await prune();
    expect(report.removed).toEqual(['.prune-v0.2.0-4567cdef']);
    expect(report.skipped.map((s) => s.name)).toEqual(['.prune-v0.1.0-0123abcd']);
    expect(removeIsolated).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf-8')).toBe('keep me');
  });

  it('one entry that cannot be examined does not stop the others', async () => {
    folder('v0.1.0');
    folder('v0.2.0');
    const real = fs.realpathSync.native;
    const spy = vi.spyOn(fs.realpathSync, 'native').mockImplementation(((p: fs.PathLike, o?: unknown) => {
      if (String(p).endsWith('v0.1.0')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return (real as (p: fs.PathLike, o?: unknown) => string)(p, o);
    }) as typeof fs.realpathSync.native);
    try {
      const report = await prune();
      expect(report.removed).toEqual(['v0.2.0']);
      expect(report.skipped).toEqual([{ name: 'v0.1.0', reason: expect.stringMatching(/could not be examined.*EACCES/) }]);
    } finally {
      spy.mockRestore();
    }
  });

  it('leaves a file named like a version alone', async () => {
    fs.writeFileSync(path.join(hub, 'v0.1.0'), 'a file');
    const report = await prune();
    expect(report.removed).toEqual([]);
    expect(report.skipped).toEqual([{ name: 'v0.1.0', reason: expect.stringMatching(/not a folder/) }]);
    expect(fs.readFileSync(path.join(hub, 'v0.1.0'), 'utf-8')).toBe('a file');
  });

  it('is a no-op on an empty hub folder', async () => {
    expect(await prune()).toEqual({ removed: [], failed: [], skipped: [] });
  });
});
