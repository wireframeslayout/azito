import { describe, expect, it } from 'vitest';
import { claudeProjectDirName } from './projectDirName';

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
    expect(claudeProjectDirName(platform, workingDirectory)).toBe(expected);
  });

  it('keeps a name of exactly 200 characters as it is', () => {
    const path = `/${'a'.repeat(199)}`;
    expect(claudeProjectDirName('linux', path)).toBe(`-${'a'.repeat(199)}`);
  });

  it('cuts a longer name to 200 characters and appends the base-36 hash of the whole path', () => {
    const path = `/${'a'.repeat(249)}`;
    expect(claudeProjectDirName('linux', path)).toBe(`-${'a'.repeat(199)}-wkpu26`);
  });

  it('hashes the original (not the dashed) path, so two long paths that differ only in punctuation stay apart', () => {
    const a = `/${'a'.repeat(250)}.x`;
    const b = `/${'a'.repeat(250)}_x`;
    expect(claudeProjectDirName('linux', a)).not.toBe(claudeProjectDirName('linux', b));
  });
});
