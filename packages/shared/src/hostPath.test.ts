import * as nodePath from 'path';
import { describe, expect, it } from 'vitest';
import { hostPathFor } from './hostPath';

const WIN_PATHS = [
  'C:\\Users\\me', 'C:/Users/me', 'C:\\', 'C:/', 'C:', 'C:foo', 'C:\\a\\b\\', 'C:\\a\\..\\b', 'C:\\..\\..\\x', 'c:\\A/b\\c',
  '\\\\server\\share\\dir\\file', '//server/share/x', '\\\\server\\share\\a\\..\\..\\b',
  '\\\\server\\share', '\\\\server\\share\\', '//server/share/', '\\\\server', '\\\\server\\', 'c:\\A/b\\\\c', 'C:\\a\\\\b', 'C:foo/../', 'C:foo\\', 'C:.\\',
  '\\\\?\\C:\\x', '//', '\\\\\\a', 'C:\\\\\\a',
  '\\rooted\\x', '/rooted/x', '\\', 'rel\\a', 'rel/a/./b', '..\\a', 'a\\..\\..\\b', '.', '',
  'C:\\Users\\日本語\\プロジェクト', 'C:\\Program Files\\My App\\x.txt', 'D:\\a b\\c d\\', 'C:\\dir\\file.tar.gz',
];
const POSIX_PATHS = [
  '/home/me', '/', '//', '//a', '//a//b', '/a//b', 'a//b', '///a', '/a/b/', '/a//', 'a/', '/a/../b', '/../../x', 'a/b', './a/./b', '../a', 'a/../../b', '.', '', './',
  '/home/日本語/プロジェクト', '/tmp/my dir/x y.txt', '/a/b/file.tar.gz', '~/work', 'a\\b',
];

describe('hostPathFor: same results as Node path', () => {
  const cases = [
    ['win32', nodePath.win32, WIN_PATHS],
    ['linux', nodePath.posix, POSIX_PATHS],
  ] as const;
  for (const [platform, node, paths] of cases) {
    const api = hostPathFor(platform);
    describe(platform, () => {
      it('sep', () => expect(api.sep).toBe(node.sep));
      it.each(paths)('normalize %j', (p) => expect(api.normalize(p)).toBe(node.normalize(p)));
      it.each(paths)('dirname %j', (p) => expect(api.dirname(p)).toBe(node.dirname(p)));
      it.each(paths)('basename %j', (p) => expect(api.basename(p)).toBe(node.basename(p)));
      it.each(paths)('isAbsolute %j', (p) => expect(api.isAbsolute(p)).toBe(node.isAbsolute(p)));
      it('basename with ext', () => {
        expect(api.basename('/x/file.tar.gz', '.gz')).toBe(node.basename('/x/file.tar.gz', '.gz'));
        expect(api.basename('/x/.gz', '.gz')).toBe(node.basename('/x/.gz', '.gz'));
        expect(api.basename('foo', 'foo')).toBe(node.basename('foo', 'foo'));
        expect(api.basename('foo', 'foo')).toBe('');
        expect(api.basename('/x/foo', 'foo')).toBe(node.basename('/x/foo', 'foo'));
        expect(api.basename('/x/foo', 'foo')).toBe('foo');
      });
      it.each([
        [paths[0], 'a'], [paths[0], '..\\x'], [paths[0], '../x/y'], [paths[1], 'b/c'], ['', 'a'], ['a', ''], [paths[0], ''], ['.', 'a'],
      ])('join %j + %j', (a, b) => expect(api.join(a, b)).toBe(node.join(a, b)));
      it('join of many parts and empty list', () => {
        expect(api.join()).toBe(node.join());
        expect(api.join('', '')).toBe(node.join('', ''));
        expect(api.join(paths[0], 'a', '', '..', 'b/')).toBe(node.join(paths[0], 'a', '', '..', 'b/'));
      });
    });
  }

  describe('win32 join keeps a rooted path from becoming UNC', () => {
    const api = hostPathFor('win32');
    it.each([
      ['\\', '\\x'], ['\\', 'x'], ['C:\\', '\\x'], ['C:', 'x'], ['\\\\server\\share', 'x'], ['\\\\server\\share\\', '\\x'],
    ])('%j + %j', (a, b) => expect(api.join(a, b)).toBe(nodePath.win32.join(a, b)));
  });

  describe('relative', () => {
    const win: [string, string][] = [
      ['C:\\a\\b', 'C:\\a\\b\\c\\d'], ['C:\\a\\b', 'C:\\a'], ['C:\\a\\b', 'C:\\a\\x'], ['C:\\a\\b', 'C:\\a\\b'], ['C:\\a\\b\\', 'C:\\a\\b'],
      ['C:\\a\\b', 'C:\\A\\B\\c'], ['C:/a/b', 'C:\\a\\c'], ['C:\\a', 'D:\\a'], ['C:\\', 'C:\\a'], ['C:\\a', 'C:\\'],
      ['\\\\srv\\share\\a', '\\\\srv\\share\\a\\b'], ['\\\\srv\\share\\a', '\\\\srv\\other\\a'], ['\\\\srv\\a', '\\\\srv\\b'], ['\\\\srv1\\a\\b', '\\\\srv2\\a'], ['\\\\SRV\\Share', '\\\\srv\\share\\x'], ['C:\\日本語', 'C:\\日本語\\子'],
      ['C:\\My Dir\\a', 'C:\\My Dir\\a\\b c'], ['C:\\a\\b\\..\\c', 'C:\\a\\c\\d'],
    ];
    it.each(win)('win32 %j -> %j', (a, b) => expect(hostPathFor('win32').relative(a, b)).toBe(nodePath.win32.relative(a, b)));
    const posix: [string, string][] = [
      ['/a/b', '/a/b/c'], ['/a/b', '/a'], ['/a/b', '/x/y'], ['/a/b', '/a/b'], ['/a/b/', '/a/b'], ['/', '/a'], ['/a', '/'], ['/a/B', '/a/b'],
      ['/home/日本語', '/home/日本語/x'], ['/my dir', '/my dir/a b'],
    ];
    it.each(posix)('posix %j -> %j', (a, b) => expect(hostPathFor('linux').relative(a, b)).toBe(nodePath.posix.relative(a, b)));
  });

  describe('samePath', () => {
    it('win32 ignores case, separators and a trailing separator', () => {
      const api = hostPathFor('win32');
      expect(api.samePath('C:\\Users\\Me\\', 'c:/users/me')).toBe(true);
      expect(api.samePath('C:\\a', 'C:\\b')).toBe(false);
      expect(api.samePath('C:\\', 'c:/')).toBe(true);
      expect(api.samePath('\\\\Srv\\Share\\x', '//srv/share/X/')).toBe(true);
    });
    it('posix is case-sensitive', () => {
      const api = hostPathFor('darwin');
      expect(api.samePath('/a/b/', '/a/b')).toBe(true);
      expect(api.samePath('/a/B', '/a/b')).toBe(false);
    });
  });
});
