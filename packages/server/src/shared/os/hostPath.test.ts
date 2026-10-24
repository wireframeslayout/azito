import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { invalidHostPathReason, invalidWorkingDirectoryReason, invalidWorkingDirectoryReasonFor, isHostPathContained, isHomeRelativePath, pathApiFor } from './hostPath';

describe('invalidWorkingDirectoryReason', () => {
  it('accepts an absolute path or ~ of the host, with spaces and Japanese', () => {
    expect(invalidWorkingDirectoryReason('linux', '/srv/my repo/日本語')).toBeNull();
    expect(invalidWorkingDirectoryReason('linux', '~')).toBeNull();
    expect(invalidWorkingDirectoryReason('win32', 'C:\\My Repo\\日本語')).toBeNull();
    expect(invalidWorkingDirectoryReason('win32', '~\\x')).toBeNull();
    expect(invalidWorkingDirectoryReason('win32', '~/x')).toBeNull();
  });

  it('refuses a relative path and what invalidHostPathReason refuses', () => {
    expect(invalidWorkingDirectoryReason('linux', 'repo')).toMatch(/absolute/);
    expect(invalidWorkingDirectoryReason('linux', '~user/x')).toMatch(/absolute/);
    expect(invalidWorkingDirectoryReason('win32', 'repo')).toMatch(/absolute/);
    expect(invalidWorkingDirectoryReason('win32', 'C:foo')).toMatch(/drive-relative/);
    expect(invalidWorkingDirectoryReason('linux', '')).toMatch(/empty/);
  });

  it('knows ~\\ only on win32', () => {
    expect(isHomeRelativePath('win32', '~\\x')).toBe(true);
    expect(isHomeRelativePath('linux', '~\\x')).toBe(false);
  });
});

describe('invalidWorkingDirectoryReasonFor', () => {
  it('uses the rules of a known platform', () => {
    expect(invalidWorkingDirectoryReasonFor('linux', 'C:\\x')).toMatch(/absolute/);
    expect(invalidWorkingDirectoryReasonFor('win32', 'C:\\x')).toBeNull();
  });

  it('without a platform accepts what is valid on either OS', () => {
    expect(invalidWorkingDirectoryReasonFor(null, '/srv/x')).toBeNull();
    expect(invalidWorkingDirectoryReasonFor(null, 'C:\\x')).toBeNull();
    expect(invalidWorkingDirectoryReasonFor(null, 'x')).toMatch(/absolute/);
  });
});

describe('pathApiFor', () => {
  it('gives each OS its own rules, whichever OS runs the code', () => {
    expect(pathApiFor('win32')).toBe(path.win32);
    expect(pathApiFor('linux')).toBe(path.posix);
    expect(pathApiFor('darwin')).toBe(path.posix);
    expect(pathApiFor('win32').join('C:\\work', 'a', 'b.txt')).toBe('C:\\work\\a\\b.txt');
    expect(pathApiFor('linux').join('/work', 'a', 'b.txt')).toBe('/work/a/b.txt');
  });
});

describe('invalidHostPathReason', () => {
  it('accepts ordinary paths on every host', () => {
    expect(invalidHostPathReason('linux', '/srv/it\'s a dir; echo $HOME/file')).toBeNull();
    expect(invalidHostPathReason('darwin', '/Users/u/a:b')).toBeNull(); // a colon is an ordinary name character off Windows
    expect(invalidHostPathReason('win32', 'C:\\work\\proj\\src\\a.ts')).toBeNull();
    expect(invalidHostPathReason('win32', 'C:/work/proj')).toBeNull();
    expect(invalidHostPathReason('win32', '\\\\server\\share\\dir')).toBeNull();
    expect(invalidHostPathReason('win32', 'relative\\dir')).toBeNull();
  });

  it('refuses an empty path and a NUL byte on every host', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(invalidHostPathReason(platform, '')).toMatch(/empty/);
      expect(invalidHostPathReason(platform, '/a\0b')).toMatch(/NUL/);
    }
  });

  it('refuses a Windows device path in either slash style', () => {
    for (const p of ['\\\\.\\C:\\x', '\\\\?\\C:\\x', '\\\\?\\UNC\\server\\share', '//./C:/x', '//?/C:/x', '\\??\\C:\\x']) {
      expect(invalidHostPathReason('win32', p), p).toMatch(/device/);
    }
  });

  it('refuses a drive-relative path', () => {
    for (const p of ['C:foo', 'c:foo\\bar', 'D:', 'C:..\\x']) {
      expect(invalidHostPathReason('win32', p), p).toMatch(/drive-relative/);
    }
  });

  it('refuses an alternate data stream', () => {
    for (const p of ['C:\\work\\file.txt:hidden', 'C:\\work\\file.txt::$DATA', 'C:\\work\\dir:stream\\x', 'file:stream', '\\\\server\\share\\f:s']) {
      expect(invalidHostPathReason('win32', p), p).toMatch(/alternate data stream/);
    }
  });
});

describe('isHostPathContained', () => {
  it('accepts the root itself and a path beneath it', () => {
    expect(isHostPathContained('linux', { target: '/a/b', allowedRoot: '/a/b' })).toBe(true);
    expect(isHostPathContained('linux', { target: '/a/b/c', allowedRoot: '/a/b' })).toBe(true);
  });

  it('rejects a sibling that merely shares a string prefix, an escape by .. and an unrelated path', () => {
    expect(isHostPathContained('linux', { target: '/a/bc', allowedRoot: '/a/b' })).toBe(false);
    expect(isHostPathContained('linux', { target: '/a/b/../../etc', allowedRoot: '/a/b' })).toBe(false);
    expect(isHostPathContained('linux', { target: '/etc', allowedRoot: '/a/b' })).toBe(false);
  });

  it('accepts a child whose name starts with two dots (a bare startsWith("..") would over-reject it)', () => {
    expect(isHostPathContained('linux', { target: '/a/b/..cache', allowedRoot: '/a/b' })).toBe(true);
    expect(isHostPathContained('linux', { target: '/a/b/..cache/nested', allowedRoot: '/a/b' })).toBe(true);
  });

  it('swapping target and allowedRoot flips the verdict', () => {
    expect(isHostPathContained('linux', { target: '/a/b/c', allowedRoot: '/a/b' })).toBe(true);
    expect(isHostPathContained('linux', { target: '/a/b', allowedRoot: '/a/b/c' })).toBe(false);
  });

  describe('win32 (checked here with path.win32 on any OS)', () => {
    const root = 'C:\\work\\proj';

    it('accepts the root and what is beneath it, with either slash', () => {
      expect(isHostPathContained('win32', { target: root, allowedRoot: root })).toBe(true);
      expect(isHostPathContained('win32', { target: 'C:\\work\\proj\\src\\a.ts', allowedRoot: root })).toBe(true);
      expect(isHostPathContained('win32', { target: 'C:/work/proj/src', allowedRoot: root })).toBe(true);
      expect(isHostPathContained('win32', { target: 'C:\\work\\proj\\..cache', allowedRoot: root })).toBe(true);
    });

    it('rejects another drive', () => {
      expect(isHostPathContained('win32', { target: 'D:\\work\\proj\\src', allowedRoot: root })).toBe(false);
    });

    it('rejects another UNC share, and a UNC path against a drive root', () => {
      const share = '\\\\server\\share\\proj';
      expect(isHostPathContained('win32', { target: '\\\\server\\share\\proj\\src', allowedRoot: share })).toBe(true);
      expect(isHostPathContained('win32', { target: '\\\\server\\other\\proj\\src', allowedRoot: share })).toBe(false);
      expect(isHostPathContained('win32', { target: '\\\\other\\share\\proj\\src', allowedRoot: share })).toBe(false);
      expect(isHostPathContained('win32', { target: share, allowedRoot: root })).toBe(false);
    });

    it('rejects a sibling with a shared prefix and an escape by ..', () => {
      expect(isHostPathContained('win32', { target: 'C:\\work\\proj2', allowedRoot: root })).toBe(false);
      expect(isHostPathContained('win32', { target: 'C:\\work\\proj\\..\\other', allowedRoot: root })).toBe(false);
      expect(isHostPathContained('win32', { target: 'C:\\work', allowedRoot: root })).toBe(false);
    });

    it('does not take the same directory spelled with another case for the root itself', () => {
      expect(isHostPathContained('win32', { target: 'C:\\work\\Proj', allowedRoot: root })).toBe(false);
      expect(isHostPathContained('win32', { target: 'C:\\WORK\\proj', allowedRoot: root })).toBe(false);
      expect(isHostPathContained('win32', { target: root, allowedRoot: root })).toBe(true);
    });

    it('does not fold case: a directory may be case-sensitive, where Proj is not proj', () => {
      expect(isHostPathContained('win32', { target: 'C:\\work\\Proj\\src', allowedRoot: root })).toBe(false);
      expect(isHostPathContained('win32', { target: 'C:\\work\\proj\\Src', allowedRoot: root })).toBe(true);
    });
  });
});
