import { describe, expect, it } from 'vitest';
import {
  fileDisplayName, fileTabPath, findByPath, joinRelative, parentOrRoot, serverPathApi, typedDirectoryPrefix, withTrailingSeparator,
} from './serverPath';

const posix = serverPathApi({ platform: 'linux' });
const win = serverPathApi({ platform: 'win32' });

describe('serverPathApi', () => {
  it('treats an unrecorded host as POSIX', () => {
    expect(serverPathApi(null).sep).toBe('/');
    expect(serverPathApi(undefined).sep).toBe('/');
    expect(serverPathApi({ platform: 'darwin' }).sep).toBe('/');
    expect(win.sep).toBe('\\');
  });

  it('returns one instance per OS so it can sit in a dependency array', () => {
    expect(serverPathApi({ platform: 'win32' })).toBe(win);
    expect(serverPathApi(null)).toBe(posix);
  });
});

describe('joinRelative', () => {
  it('joins a "/"-separated git or search path in the host spelling', () => {
    expect(joinRelative(posix, '/work/app', 'src/a.ts')).toBe('/work/app/src/a.ts');
    expect(joinRelative(posix, '/work/app/', 'src/a.ts')).toBe('/work/app/src/a.ts');
    expect(joinRelative(win, 'C:\\work\\app', 'src/a.ts')).toBe('C:\\work\\app\\src\\a.ts');
    expect(joinRelative(win, 'C:\\work\\app\\', 'src/日本語 a.ts')).toBe('C:\\work\\app\\src\\日本語 a.ts');
  });

  it('keeps a backslash in a POSIX file name as part of the name', () => {
    expect(joinRelative(posix, '/w', 'a\\b.txt')).toBe('/w/a\\b.txt');
  });
});

describe('parentOrRoot', () => {
  it('gives the root itself, in its own spelling, for an entry directly under it', () => {
    expect(parentOrRoot(posix, '/work/app/a.ts', '/work/app')).toBe('/work/app');
    expect(parentOrRoot(posix, '/a.ts', '/')).toBe('/');
    expect(parentOrRoot(win, 'C:\\work\\app\\a.ts', 'c:\\Work\\app\\')).toBe('c:\\Work\\app\\');
  });

  it('gives the containing directory otherwise', () => {
    expect(parentOrRoot(posix, '/work/app/src/a.ts', '/work/app')).toBe('/work/app/src');
    expect(parentOrRoot(win, 'C:\\work\\app\\src\\a.ts', 'C:\\work\\app')).toBe('C:\\work\\app\\src');
  });
});

describe('fileTabPath', () => {
  it('leaves a POSIX path as it came, so stored tab ids stay valid', () => {
    expect(fileTabPath(posix, '/work//app/./a.ts')).toBe('/work//app/./a.ts');
  });

  it('spells one Windows file one way', () => {
    expect(fileTabPath(win, 'C:/work/app/a.ts')).toBe('C:\\work\\app\\a.ts');
    expect(fileTabPath(win, 'C:\\work\\app\\.\\a.ts')).toBe('C:\\work\\app\\a.ts');
  });

  it('gives a diff-opened file the id of the tree-opened one', () => {
    const fromTree = fileTabPath(win, 'C:\\work\\app\\src\\a.ts');
    const fromDiff = fileTabPath(win, joinRelative(win, 'C:\\work\\app\\', 'src/a.ts'));
    expect(fromDiff).toBe(fromTree);
  });
});

describe('fileDisplayName', () => {
  it('is the last segment in the host spelling', () => {
    expect(fileDisplayName(posix, '/work/app/a.ts')).toBe('a.ts');
    expect(fileDisplayName(win, 'C:\\work\\app\\a.ts')).toBe('a.ts');
    expect(fileDisplayName(win, 'C:/work/app/a.ts')).toBe('a.ts');
  });

  it('keeps a backslash in a POSIX file name', () => {
    expect(fileDisplayName(posix, '/w/a\\b.txt')).toBe('a\\b.txt');
  });
});

describe('DirectoryInput helpers', () => {
  it('adds the host separator to a completed candidate, once', () => {
    expect(withTrailingSeparator(posix, '/work')).toBe('/work/');
    expect(withTrailingSeparator(posix, '/')).toBe('/');
    expect(withTrailingSeparator(win, 'C:\\work')).toBe('C:\\work\\');
    expect(withTrailingSeparator(win, 'C:\\')).toBe('C:\\');
  });

  it('finds the directory part of what was typed', () => {
    expect(typedDirectoryPrefix(posix, '/work/ap')).toBe('/work/');
    expect(typedDirectoryPrefix(posix, '/work/')).toBe('/work/');
    expect(typedDirectoryPrefix(posix, 'ap')).toBe('');
    expect(typedDirectoryPrefix(win, 'C:\\work\\ap')).toBe('C:\\work\\');
    expect(typedDirectoryPrefix(win, 'C:/work/ap')).toBe('C:/work/');
    expect(typedDirectoryPrefix(win, 'C:')).toBe('');
  });
});

describe('findByPath', () => {
  const items = [{ path: 'C:\\Work\\App' }, { path: 'C:\\Work\\App\\.worktrees\\t1' }];

  it('compares as the host does', () => {
    expect(findByPath(win, items, 'c:/work/app/')).toBe(items[0]);
    expect(findByPath(win, items, 'C:\\other')).toBeNull();
  });

  it('is case-sensitive on POSIX', () => {
    const unix = [{ path: '/Work/App' }];
    expect(findByPath(posix, unix, '/Work/App/')).toBe(unix[0]);
    expect(findByPath(posix, unix, '/work/app')).toBeNull();
  });
});
