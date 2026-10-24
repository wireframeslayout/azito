import { describe, expect, it } from 'vitest';
import {
  fileDisplayName, fileTabPath, findByPath, joinRelative, parentOrRoot, platformOfServer, resolveServerPathApi, serverPathApi, serverPlatformsOf,
  typedDirectoryPrefix, withTrailingSeparator,
} from './serverPath';

const posix = serverPathApi('linux');
const win = serverPathApi('win32');

describe('serverPathApi', () => {
  it('writes "/" on Unix hosts and "\\" on Windows', () => {
    expect(serverPathApi('linux').sep).toBe('/');
    expect(serverPathApi('darwin').sep).toBe('/');
    expect(win.sep).toBe('\\');
  });

  it('returns one instance per OS so it can sit in a dependency array', () => {
    expect(serverPathApi('win32')).toBe(win);
    expect(serverPathApi('linux')).toBe(posix);
  });
});

describe('knowing the OS of a server', () => {
  const winServer = { name: 'win', hostProfile: { platform: 'win32' as const } };
  const oldAgent = { name: 'old', hostProfile: null };
  const unrecorded = { name: 'unrecorded', hostProfile: undefined };

  it('is unknown while the server is not in the list, and POSIX for a listed agent that never recorded its OS', () => {
    expect(platformOfServer(undefined)).toBeNull();
    expect(platformOfServer(oldAgent)).toBe('linux');
    expect(platformOfServer(unrecorded)).toBe('linux');
    expect(platformOfServer(winServer)).toBe('win32');
  });

  it('resolves no path functions until the list reports the server, then the right ones', () => {
    // before the first fetch
    expect(resolveServerPathApi([], 'win')).toBeNull();
    // after it
    const listed = [winServer, oldAgent];
    expect(resolveServerPathApi(listed, 'win')).toBe(win);
    expect(resolveServerPathApi(listed, 'old')).toBe(posix);
    // a name the list does not have stays unknown
    expect(resolveServerPathApi(listed, 'gone')).toBeNull();
    expect(resolveServerPathApi(listed, null)).toBeNull();
  });
});

describe('the server list kept in sessionStorage', () => {
  // The cached copy was taken before the agent reported its OS; the fresh list knows it is Windows.
  const cached = [{ name: 'win', hostProfile: null }];
  const fetched = [{ name: 'win', hostProfile: { platform: 'win32' as const } }];

  it('decides nothing about a host until this page load has fetched the list', () => {
    expect(serverPlatformsOf(cached, false).size).toBe(0);
    expect(serverPlatformsOf(fetched, false).size).toBe(0);
  });

  it('gives the fetched answer even where the cached one differed', () => {
    expect(serverPlatformsOf(cached, true).get('win')).toBe('linux');
    expect(serverPlatformsOf(fetched, true).get('win')).toBe('win32');
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

  it('does not normalize a POSIX base, so its strings stay what they were', () => {
    expect(joinRelative(posix, '/work//app/.', 'src/a.ts')).toBe('/work//app/./src/a.ts');
    expect(joinRelative(posix, '/work/../app/', 'src/a.ts')).toBe('/work/../app/src/a.ts');
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

describe('one POSIX file, one tab id', () => {
  // A root with a doubled slash and a dot: the strings that saved tabs were keyed by.
  const root = '/work//app/.';
  const savedId = `file:s:${root}/src/a.ts`;
  const idOf = (filePath: string): string => `file:s:${fileTabPath(posix, filePath)}`;

  it('is the same from a saved tab, the tree, a diff and a search hit', () => {
    const fromTree = `${root}/src/a.ts`; // the server lists dirPath + '/' + name
    expect(idOf(fromTree)).toBe(savedId);
    expect(idOf(joinRelative(posix, root, 'src/a.ts'))).toBe(savedId); // diff and search
    expect(idOf(joinRelative(posix, `${root}/`, 'src/a.ts'))).toBe(`file:s:${root}/src/a.ts`);
  });
});
