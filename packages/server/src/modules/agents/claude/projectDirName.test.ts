import { describe, expect, it } from 'vitest';
import { claudeProjectDirNames } from './projectDirName';

describe('claudeProjectDirName (Claude Code: every non-alphanumeric character becomes "-", 200 characters at most + hash)', () => {
  it.each([
    ['linux', '/work/app', '-work-app'],
    ['linux', '/work/my.app', '-work-my-app'],
    ['linux', '/work/my_app', '-work-my-app'],
    ['linux', '/work/my app', '-work-my-app'],
    ['linux', '/work/my-app', '-work-my-app'],
    ['linux', '/work/日本語', '-work----'],
    ['linux', '/work/😀', '-work---'],
    ['linux', '/work/.worktrees/task-12', '-work--worktrees-task-12'],
    ['linux', '/work/app//', '-work-app'],
    ['linux', '/', '-'],
    ['linux', '/work/a\\b', '-work-a-b'],
    ['darwin', '/Users/me/My Project', '-Users-me-My-Project'],
    ['win32', 'C:\\Users\\me\\app', 'C--Users-me-app'],
    ['win32', 'C:/Users/me/app', 'C--Users-me-app'],
    ['win32', 'C:\\Users\\me\\app\\', 'C--Users-me-app'],
    ['win32', 'D:\\work\\日本語 app', 'D--work-----app'],
    ['win32', 'C:\\', 'C--'],
    ['win32', '\\\\server\\share\\dir', '--server-share-dir'],
  ] as const)('%s: %s -> %s', (platform, workingDirectory, expected) => {
    expect(claudeProjectDirNames(platform, workingDirectory)).toEqual([expected]);
  });

  it('keeps a name of exactly 200 characters as it is', () => {
    expect(claudeProjectDirNames('linux', `/${'a'.repeat(199)}`)).toEqual([`-${'a'.repeat(199)}`]);
  });

  it('for a longer name lists the cut name with the base-36 hash of the whole path, then the uncut name (older Claude Code)', () => {
    expect(claudeProjectDirNames('linux', `/${'a'.repeat(249)}`)).toEqual([`-${'a'.repeat(199)}-wkpu26`, `-${'a'.repeat(249)}`]);
  });

  it('hashes the original (not the dashed) path, so two long paths that differ only in punctuation stay apart', () => {
    const [a] = claudeProjectDirNames('linux', `/${'a'.repeat(250)}.x`);
    const [b] = claudeProjectDirNames('linux', `/${'a'.repeat(250)}_x`);
    expect(a).not.toBe(b);
  });
});
