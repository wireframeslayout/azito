import { describe, expect, it } from 'vitest';
import { serverPathApi } from '../../lib/serverPath';
import { getWorktreeName } from './WorktreePickerItem';
import type { WorktreeItem } from './RootSwitcher';

const item = (path: string, isMain: boolean): WorktreeItem => ({ path, isMain, branch: null, head: '' }) as WorktreeItem;

describe('getWorktreeName', () => {
  const posix = serverPathApi('linux');
  const win = serverPathApi('win32');

  it('names the main checkout by its directory', () => {
    expect(getWorktreeName(item('/work/app', true), posix)).toBe('app');
    expect(getWorktreeName(item('C:\\work\\app', true), win)).toBe('app');
  });

  it('names a worktree by its folder under .worktrees', () => {
    expect(getWorktreeName(item('/work/app/.worktrees/task-1', false), posix)).toBe('task-1');
    expect(getWorktreeName(item('C:\\work\\app\\.worktrees\\task-1', false), win)).toBe('task-1');
    expect(getWorktreeName(item('C:/work/app/.worktrees/task-1', false), win)).toBe('task-1');
  });

  it('shows the whole path for a worktree outside .worktrees', () => {
    expect(getWorktreeName(item('/elsewhere/wt', false), posix)).toBe('/elsewhere/wt');
  });
});
