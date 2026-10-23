import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { LocalFileOps, localFileOpsHost } from '../../shared/fs/LocalFileOps';
import { assertDirectoryContained, assertNewPathContained, assertPathContained } from './PathContainment';

const ops = new LocalFileOps(localFileOpsHost({ platform: process.platform, homeDir: tmpdir() }));

let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'azito-containment-')));
  root = path.join(base, 'root');
  outside = path.join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** A directory symbolic link; on Windows a junction (a symlink needs a privilege there, a junction does not). */
function linkDirectory(target: string, link: string): void {
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

describe('assertPathContained', () => {
  it('resolves and passes when the target is within the allowed root, returning the real path to use', async () => {
    const target = path.join(root, 'sub');
    mkdirSync(target);
    await expect(assertPathContained(ops, { target, allowedRoot: root }, 'test path')).resolves.toBe(await ops.realpath(target));
  });

  it('accepts the root itself', async () => {
    await expect(assertPathContained(ops, { target: root, allowedRoot: root }, 'test path')).resolves.toBe(root);
  });

  it('rejects when the target escapes the root via ..', async () => {
    await expect(assertPathContained(ops, { target: path.join(root, '..', 'outside'), allowedRoot: root }, 'test path'))
      .rejects.toThrow(/escapes the allowed directory/);
  });

  it('rejects when a link inside the root points outside it', async () => {
    const link = path.join(root, 'escape-link');
    linkDirectory(outside, link);
    await expect(assertPathContained(ops, { target: link, allowedRoot: root }, 'test path')).rejects.toThrow(/escapes the allowed directory/);
  });

  it('rejects a path reached through a link that leaves the root', async () => {
    linkDirectory(outside, path.join(root, 'escape-link'));
    writeFileSync(path.join(outside, 'secret.txt'), 'x');
    await expect(assertPathContained(ops, { target: path.join(root, 'escape-link', 'secret.txt'), allowedRoot: root }, 'test path'))
      .rejects.toThrow(/escapes the allowed directory/);
  });

  it('accepts a link that stays inside the root, returning the resolved path', async () => {
    const real = path.join(root, 'real');
    mkdirSync(real);
    const link = path.join(root, 'alias');
    linkDirectory(real, link);
    await expect(assertPathContained(ops, { target: link, allowedRoot: root }, 'test path')).resolves.toBe(await ops.realpath(real));
  });

  it('judges a root that is itself reached through a link by the real paths on both sides', async () => {
    const rootLink = path.join(base, 'root-link');
    linkDirectory(root, rootLink);
    mkdirSync(path.join(root, 'sub'));
    await expect(assertPathContained(ops, { target: path.join(root, 'sub'), allowedRoot: rootLink }, 'test path')).resolves.toBeTruthy();
  });

  it('rejects (fails closed) when the target does not exist', async () => {
    await expect(assertPathContained(ops, { target: path.join(root, 'nope'), allowedRoot: root }, 'test path')).rejects.toThrow(/Cannot verify/);
  });

  it('rejects (fails closed) when the root does not exist', async () => {
    await expect(assertPathContained(ops, { target: root, allowedRoot: path.join(base, 'no-root') }, 'test path')).rejects.toThrow(/Cannot verify/);
  });

  it('swapping target and allowedRoot flips the verdict (the {target, allowedRoot} object shape makes a swap visible at every call site; do not revert it to positional strings)', async () => {
    const child = path.join(root, 'sub');
    mkdirSync(child);
    await expect(assertPathContained(ops, { target: child, allowedRoot: root }, 'test path')).resolves.toBeTruthy();
    await expect(assertPathContained(ops, { target: root, allowedRoot: child }, 'test path')).rejects.toThrow(/escapes the allowed directory/);
  });

  it('does not restrict the character set of a path: a name with shell-sensitive characters or a space is contained like any other', async () => {
    const odd = path.join(root, process.platform === 'win32' ? "it's a dir; echo %HOME%" : "it's-a-dir; echo $HOME");
    mkdirSync(odd);
    const link = path.join(root, 'safe-looking-link');
    linkDirectory(odd, link);
    await expect(assertPathContained(ops, { target: link, allowedRoot: root }, 'test path')).resolves.toBe(await ops.realpath(odd));
  });

  it('rejects a path with a NUL byte before the host is asked', async () => {
    await expect(assertPathContained(ops, { target: `${root}\0x`, allowedRoot: root }, 'test path')).rejects.toThrow(/Cannot verify.*NUL/);
  });
});

describe('assertNewPathContained', () => {
  it('accepts a path that does not exist yet under the root, resolving its nearest existing parent', async () => {
    const resolved = await assertNewPathContained(ops, { target: path.join(root, 'a', 'b', 'new.txt'), allowedRoot: root }, 'new path');
    expect(resolved).toBe(path.join(await ops.realpath(root), 'a', 'b', 'new.txt'));
  });

  it('accepts an existing path too', async () => {
    mkdirSync(path.join(root, 'sub'));
    await expect(assertNewPathContained(ops, { target: path.join(root, 'sub'), allowedRoot: root }, 'new path')).resolves.toBe(path.join(root, 'sub'));
  });

  it('rejects a new path that is lexically under the root but behind a link that leaves it', async () => {
    linkDirectory(outside, path.join(root, 'escape-link'));
    await expect(assertNewPathContained(ops, { target: path.join(root, 'escape-link', 'new.txt'), allowedRoot: root }, 'new path'))
      .rejects.toThrow(/escapes the allowed directory/);
  });

  it('rejects a new path that climbs out of the root through a part that does not exist', async () => {
    // Built by hand: path.join would normalize the dots away before the check ever saw them.
    const climbing = [root, 'missing', '..', '..', 'outside', 'x.txt'].join(path.sep);
    await expect(assertNewPathContained(ops, { target: climbing, allowedRoot: root }, 'new path'))
      .rejects.toThrow(/escapes the allowed directory/);
  });

  // Windows reports a path below a file as "not found" (no ENOTDIR), so the walk goes past it there; the creation then fails.
  it.skipIf(process.platform === 'win32')('rejects (fails closed) when a file sits where a directory should be, instead of walking past it', async () => {
    writeFileSync(path.join(root, 'file.txt'), 'x');
    await expect(assertNewPathContained(ops, { target: path.join(root, 'file.txt', 'child'), allowedRoot: root }, 'new path'))
      .rejects.toThrow(/Cannot verify/);
  });
});

describe('assertDirectoryContained', () => {
  it('skips resolution and returns the target unchanged when allowedRoot is unset (no configured boundary)', async () => {
    await expect(assertDirectoryContained(ops, { target: '/does/not/exist/at/all', allowedRoot: null }, 'test path')).resolves.toBe('/does/not/exist/at/all');
    await expect(assertDirectoryContained(ops, { target: '/does/not/exist/at/all', allowedRoot: undefined }, 'test path')).resolves.toBe('/does/not/exist/at/all');
  });

  it('returns the resolved path when contained and rejects when not', async () => {
    const target = path.join(root, 'sub');
    mkdirSync(target);
    await expect(assertDirectoryContained(ops, { target, allowedRoot: root }, 'test path')).resolves.toBe(await ops.realpath(target));
    await expect(assertDirectoryContained(ops, { target: outside, allowedRoot: root }, 'test path')).rejects.toThrow(/escapes the allowed directory/);
  });

  it('swapping target and allowedRoot flips the verdict through the wrapper every real caller goes through', async () => {
    const child = path.join(root, 'sub');
    mkdirSync(child);
    await expect(assertDirectoryContained(ops, { target: child, allowedRoot: root }, 'test path')).resolves.toBeTruthy();
    await expect(assertDirectoryContained(ops, { target: root, allowedRoot: child }, 'test path')).rejects.toThrow(/escapes the allowed directory/);
  });
});

// Windows: a real junction and the filesystem's own spelling of a path. Linux/macOS skip these (the rules themselves are in hostPath.test.ts).
describe.skipIf(process.platform !== 'win32')('assertPathContained on Windows', () => {
  it('follows a junction out of the root', async () => {
    const junction = path.join(root, 'junction');
    symlinkSync(outside, junction, 'junction');
    await expect(assertPathContained(ops, { target: junction, allowedRoot: root }, 'test path')).rejects.toThrow(/escapes the allowed directory/);
  });

  it('accepts the same directory spelled with another case, since both sides are resolved to the filesystem\'s own spelling', async () => {
    mkdirSync(path.join(root, 'Sub'));
    const shouted = path.join(root.toUpperCase(), 'SUB');
    await expect(assertPathContained(ops, { target: shouted, allowedRoot: root }, 'test path')).resolves.toBe(path.join(root, 'Sub'));
  });

  it('refuses a different drive, drive-relative, device and alternate-data-stream input', async () => {
    await expect(assertPathContained(ops, { target: 'C:foo', allowedRoot: root }, 'test path')).rejects.toThrow(/drive-relative/);
    await expect(assertPathContained(ops, { target: `\\\\?\\${root}`, allowedRoot: root }, 'test path')).rejects.toThrow(/device/);
    await expect(assertPathContained(ops, { target: `${root}\\file.txt:stream`, allowedRoot: root }, 'test path')).rejects.toThrow(/alternate data stream/);
  });
});
