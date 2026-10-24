import { describe, expect, it } from 'vitest';
import { isGitDirectoryName, isWorktreeOfTask, taskIdOfWorktreePath } from './gitPath';
import { platformOfProfile } from '../../shared/os/hostProfile';

describe('taskIdOfWorktreePath', () => {
  it.each([
    ['linux', '/repo/.worktrees/task-12', 12],
    ['linux', '/home/u/my repo/日本語/.worktrees/task-3', 3],
    ['win32', 'C:\\Users\\x y\\日本語\\.worktrees\\task-5', 5],
    ['win32', 'C:/Users/x y/repo/.worktrees/task-5', 5],
    ['win32', 'C:\\repo/.worktrees\\task-7', 7],
    ['win32', '\\\\srv\\share\\repo\\.WORKTREES\\task-9', 9],
    ['win32', 'C:\\repo\\.worktrees\\task-4\\', 4],
  ] as const)('reads the id of %s %s', (platform, path, id) => {
    expect(taskIdOfWorktreePath(platform, path)).toBe(id);
  });

  it.each([
    ['linux', '/repo'],
    ['linux', '/repo/.worktrees/task-x'],
    ['linux', '/repo/.Worktrees/task-1'],
    ['linux', '/repo/other/task-1'],
    ['win32', 'C:\\repo\\.worktrees'],
    ['win32', 'C:\\repo\\work\\task-1'],
  ] as const)('is null for %s %s', (platform, path) => {
    expect(taskIdOfWorktreePath(platform, path)).toBeNull();
  });
});

describe('isWorktreeOfTask', () => {
  it('takes a task with no recorded worktree at its id', () => {
    expect(isWorktreeOfTask('win32', { worktreePath: null }, 'C:\\r\\.worktrees\\task-1')).toBe(true);
  });

  it('compares the recorded worktree with the listed one regardless of separators, a trailing one and (on win32) case', () => {
    expect(isWorktreeOfTask('win32', { worktreePath: 'c:/R/.worktrees/task-1/' }, 'C:\\r\\.worktrees\\task-1')).toBe(true);
    expect(isWorktreeOfTask('win32', { worktreePath: 'C:\\other\\.worktrees\\task-1' }, 'C:\\r\\.worktrees\\task-1')).toBe(false);
    expect(isWorktreeOfTask('linux', { worktreePath: '/R/.worktrees/task-1' }, '/r/.worktrees/task-1')).toBe(false);
  });
});

describe('isGitDirectoryName', () => {
  it('follows the host filesystem', () => {
    expect(isGitDirectoryName('linux', '.git')).toBe(true);
    expect(isGitDirectoryName('linux', '.GIT')).toBe(false);
    expect(isGitDirectoryName('darwin', '.GIT')).toBe(true);
    expect(isGitDirectoryName('win32', '.Git. ')).toBe(true);
    expect(isGitDirectoryName('win32', '.gitx')).toBe(false);
  });
});

describe('platformOfProfile', () => {
  it('reads an unrecorded agent as a Unix one', () => {
    expect(platformOfProfile(null)).toBe('linux');
    expect(platformOfProfile({ platform: 'win32', arch: 'x64' })).toBe('win32');
  });
});
