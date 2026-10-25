import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertNoLinkEntries, assertSafeEntryNames, extractZipSafely, unsafeEntryReason } from './safeArchive';
import { hostTarOf } from '../os/hostTar';
import { buildZip } from './testing/buildZip';

describe('unsafeEntryReason', () => {
  it('lets a normal entry through', () => {
    for (const ok of ['azito-hub.cjs', './azito-hub.cjs', 'node_modules/x/index.js', 'dir/', 'a..b/c', '...', 'my file (1).txt', 'v0.12.0/run.ps1']) {
      expect(unsafeEntryReason(ok), ok).toBeNull();
    }
  });

  it('refuses a ".." segment with either separator', () => {
    for (const bad of ['../x', 'a/../x', 'a/..', '..', 'a\\..\\x', '..\\x', './../x']) {
      expect(unsafeEntryReason(bad), bad).toBe('a ".." segment');
    }
  });

  it('refuses an absolute path and a drive', () => {
    for (const bad of ['/etc/passwd', '\\Windows\\x', '//server/share/x']) expect(unsafeEntryReason(bad), bad).toBe('an absolute path');
    for (const bad of ['C:/x', 'c:\\x', 'D:x', 'C:']) expect(unsafeEntryReason(bad), bad).toBe('a drive path');
  });
});

describe('assertSafeEntryNames', () => {
  it('names the first bad entry and why', () => {
    expect(() => assertSafeEntryNames(['ok.txt', '../evil.txt', '/abs'])).toThrow('Path traversal detected in archive: ../evil.txt (a ".." segment)');
  });
  it('ignores blank lines and surrounding whitespace (CRLF listings)', () => {
    expect(() => assertSafeEntryNames(['', 'a.txt\r', '  b/c.txt  '])).not.toThrow();
  });
});

describe('assertNoLinkEntries', () => {
  it('accepts files and folders', () => {
    expect(() => assertNoLinkEntries('-rw-r--r--  0 0 0 12 Jan  1  2020 a.txt\ndrwxr-xr-x  0 0 0  0 Jan  1  2020 dir/\r\n')).not.toThrow();
  });
  it('refuses a symlink, a hard link and a special file', () => {
    expect(() => assertNoLinkEntries('-rw-r--r-- 0 0 0 1 Jan 1 2020 a\nlrwxrwxrwx 0 0 0 0 Jan 1 2020 b -> /etc')).toThrow(/link or a special file.*b -> \/etc/);
    expect(() => assertNoLinkEntries('hrw-r--r-- 0 0 0 0 Jan 1 2020 c link to a')).toThrow(/link/);
    expect(() => assertNoLinkEntries('crw-rw-rw- 0 0 0 0 Jan 1 2020 dev')).toThrow(/special file/);
  });
});

let work: string;
beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'azito safe archive '));
});
afterEach(() => fs.rmSync(work, { recursive: true, force: true }));

/** Names left in `dir` (the work folders are hidden siblings of the destination, so a leftover would show here). */
const leftovers = (dir: string): string[] => fs.readdirSync(dir).sort();

/**
 * A stand-in for bsdtar that reads a text "archive" (one entry per line; `link:<name>` is a symlink, `FAIL` makes the
 * extraction die half way), so the folder handling is tested on every Unix whatever `tar` it has. The real thing is below.
 */
describe.skipIf(process.platform === 'win32')('extractZipSafely (stand-in tar)', () => {
  let fakeTar: string;
  beforeEach(() => {
    fakeTar = path.join(work, 'fake-tar');
    fs.writeFileSync(fakeTar, [
      '#!/bin/sh',
      'case "$1" in',
      '  -tf) sed "s/^link://" "$2" ;;',
      '  -tvf) sed -e "s/^link:\\(.*\\)$/lrwxrwxrwx 0 0 0 0 Jan 1 2020 \\1 -> x/" -e "t" -e "s/^\\(.*\\)$/-rw-r--r-- 0 0 0 0 Jan 1 2020 \\1/" "$2" ;;',
      '  -xf)',
      '    while IFS= read -r name; do',
      '      if [ "$name" = FAIL ]; then echo "tar: broken" >&2; exit 1; fi',
      '      mkdir -p "$4/$(dirname "$name")"; echo data > "$4/$name"',
      '    done < "$2" ;;',
      'esac',
    ].join('\n'), { mode: 0o755 });
  });

  const archiveOf = (lines: string[]): string => {
    const file = path.join(work, 'a.zip');
    fs.writeFileSync(file, lines.join('\n') + '\n');
    return file;
  };

  it('extracts into the destination and leaves no work folder', async () => {
    const hub = path.join(work, 'hub');
    const destination = path.join(hub, 'v1.0.0');
    await extractZipSafely({ archive: archiveOf(['run.ps1', 'node_modules/x/index.js']), destination, tar: fakeTar });
    expect(fs.readFileSync(path.join(destination, 'node_modules', 'x', 'index.js'), 'utf8')).toBe('data\n');
    expect(leftovers(hub)).toEqual(['v1.0.0']);
  });

  it('stops, with the reason, when the destination exists, and leaves it as it was', async () => {
    const hub = path.join(work, 'hub');
    const destination = path.join(hub, 'v1.0.0');
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'keep.txt'), 'mine');
    await expect(extractZipSafely({ archive: archiveOf(['run.ps1']), destination, tar: fakeTar })).rejects.toThrow(/already exists; it is not overwritten/);
    expect(fs.readFileSync(path.join(destination, 'keep.txt'), 'utf8')).toBe('mine');
    expect(leftovers(hub)).toEqual(['v1.0.0']);
  });

  it('refuses a bad name before writing anything', async () => {
    const hub = path.join(work, 'hub');
    for (const bad of ['../evil.txt', '/abs.txt', 'C:/evil.txt', 'a\\..\\evil.txt']) {
      await expect(extractZipSafely({ archive: archiveOf(['ok.txt', bad]), destination: path.join(hub, 'v1.0.0'), tar: fakeTar }), bad).rejects.toThrow(/Path traversal detected/);
    }
    expect(fs.existsSync(hub)).toBe(false);
    expect(fs.existsSync(path.join(work, 'evil.txt'))).toBe(false);
  });

  it('refuses a link entry', async () => {
    const hub = path.join(work, 'hub');
    await expect(extractZipSafely({ archive: archiveOf(['ok.txt', 'link:evil']), destination: path.join(hub, 'v1.0.0'), tar: fakeTar })).rejects.toThrow(/link or a special file/);
    expect(fs.existsSync(hub)).toBe(false);
  });

  it('removes the work folder when the extraction fails half way', async () => {
    const hub = path.join(work, 'hub');
    await expect(extractZipSafely({ archive: archiveOf(['first.txt', 'FAIL']), destination: path.join(hub, 'v1.0.0'), tar: fakeTar })).rejects.toThrow(/Could not extract/);
    expect(leftovers(hub)).toEqual([]);
  });

  it('reports an unreadable archive and an empty one', async () => {
    const hub = path.join(work, 'hub');
    await expect(extractZipSafely({ archive: path.join(work, 'missing.zip'), destination: path.join(hub, 'v1.0.0'), tar: fakeTar })).rejects.toThrow(/Could not read .* as an archive/);
    await expect(extractZipSafely({ archive: archiveOf([]), destination: path.join(hub, 'v1.0.0'), tar: fakeTar })).rejects.toThrow(/has no entries/);
  });
});

/** The real bsdtar: Windows' System32\tar.exe in CI, and the `tar` of a Mac. A Linux GNU tar cannot read a zip. */
const bsdtar = (): string | null => {
  if (process.platform === 'win32') return hostTarOf({ platform: 'win32', systemRoot: process.env.SystemRoot });
  const version = spawnSync('tar', ['--version'], { encoding: 'utf8' }).stdout ?? '';
  return version.includes('bsdtar') ? 'tar' : null;
};
const realTar = bsdtar();

describe.skipIf(realTar === null)('extractZipSafely (real tar, real zips)', () => {
  const zipAt = (name: string, entries: Parameters<typeof buildZip>[0]): string => {
    const file = path.join(work, name);
    fs.writeFileSync(file, buildZip(entries));
    return file;
  };

  it('extracts a good zip into hub\\<tag> and leaves no work folder', async () => {
    const hub = path.join(work, 'hub');
    const destination = path.join(hub, 'v0.0.0-ci-a');
    const archive = zipAt('good.zip', [
      { name: 'azito-hub.cjs', data: 'console.log(1)' },
      { name: 'node_modules/', data: '' },
      { name: 'node_modules/pkg/index.js', data: 'module.exports = 1' },
      { name: 'run.ps1', data: 'exit 0' },
    ]);
    await extractZipSafely({ archive, destination, tar: realTar! });
    expect(fs.readFileSync(path.join(destination, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('module.exports = 1');
    expect(fs.readFileSync(path.join(destination, 'run.ps1'), 'utf8')).toBe('exit 0');
    expect(leftovers(hub)).toEqual(['v0.0.0-ci-a']);
  });

  it('does not overwrite an installed version', async () => {
    const destination = path.join(work, 'hub', 'v0.0.0-ci-a');
    fs.mkdirSync(destination, { recursive: true });
    await expect(extractZipSafely({ archive: zipAt('good.zip', [{ name: 'run.ps1', data: 'x' }]), destination, tar: realTar! })).rejects.toThrow(/already exists/);
  });

  const bad: Array<[string, string]> = [
    ['a ".." segment', '../evil.txt'],
    ['a nested ".." segment', 'a/../../evil.txt'],
    ['a backslash ".." segment', 'a\\..\\..\\evil.txt'],
    ['an absolute path', '/evil.txt'],
    ['a drive path', 'C:/evil.txt'],
  ];
  it.each(bad)('refuses a zip with %s, and writes nothing', async (_label, name) => {
    const hub = path.join(work, 'hub');
    const archive = zipAt('bad.zip', [{ name: 'ok.txt', data: 'ok' }, { name, data: 'evil' }]);
    await expect(extractZipSafely({ archive, destination: path.join(hub, 'v1.0.0'), tar: realTar! })).rejects.toThrow(/Path traversal detected|Could not read/);
    expect(fs.existsSync(hub)).toBe(false);
    expect(fs.existsSync(path.join(work, 'evil.txt'))).toBe(false);
  });

  it('refuses a zip with a symlink entry', async () => {
    const hub = path.join(work, 'hub');
    const archive = zipAt('link.zip', [{ name: 'ok.txt', data: 'ok' }, { name: 'link', data: '../../outside', symlink: true }]);
    await expect(extractZipSafely({ archive, destination: path.join(hub, 'v1.0.0'), tar: realTar! })).rejects.toThrow(/link or a special file/);
    expect(fs.existsSync(hub)).toBe(false);
  });

  it('refuses a file that is not a zip, with the reason', async () => {
    const archive = path.join(work, 'junk.zip');
    fs.writeFileSync(archive, 'this is not a zip');
    await expect(extractZipSafely({ archive, destination: path.join(work, 'hub', 'v1.0.0'), tar: realTar! })).rejects.toThrow(/Could not read .* as an archive|has no entries/);
  });
});
