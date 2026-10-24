import { describe, expect, it } from 'vitest';
import { normalizeGitPath } from './gitPath';

describe('normalizeGitPath', () => {
  it('turns what git for Windows prints into the host spelling', () => {
    expect(normalizeGitPath('win32', 'C:/Users/me/repo')).toBe('C:\\Users\\me\\repo');
    expect(normalizeGitPath('win32', 'C:/Users/me/repo\r\n')).toBe('C:\\Users\\me\\repo');
    expect(normalizeGitPath('win32', 'D:/work/日本語 dir/repo\n')).toBe('D:\\work\\日本語 dir\\repo');
    expect(normalizeGitPath('win32', '//srv/share/repo')).toBe('\\\\srv\\share\\repo');
    expect(normalizeGitPath('win32', 'C:/')).toBe('C:\\');
  });

  it('leaves a path already in the host spelling alone', () => {
    expect(normalizeGitPath('win32', 'C:\\Users\\me\\repo')).toBe('C:\\Users\\me\\repo');
  });

  it('keeps an empty output empty', () => {
    expect(normalizeGitPath('win32', '')).toBe('');
    expect(normalizeGitPath('win32', '\r\n')).toBe('');
    expect(normalizeGitPath('linux', '\n')).toBe('');
  });

  it('on POSIX removes only the LF: a trailing CR belongs to the name', () => {
    expect(normalizeGitPath('linux', '/tmp/repo\r\n')).toBe('/tmp/repo\r');
  });

  it('keeps a POSIX path as git printed it, minus the line break', () => {
    expect(normalizeGitPath('linux', '/home/me/my repo\n')).toBe('/home/me/my repo');
    expect(normalizeGitPath('darwin', '/Users/me/リポジトリ')).toBe('/Users/me/リポジトリ');
  });
});
