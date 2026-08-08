import { describe, expect, it } from 'vitest';
import { parseWorktreePorcelain } from './parseWorktreePorcelain';

describe('parseWorktreePorcelain', () => {
  it('parses the main worktree', () => {
    expect(parseWorktreePorcelain('worktree /repo\nHEAD abc123\nbranch refs/heads/main\n')).toEqual([
      { path: '/repo', branch: 'main', head: 'abc123', isMain: true, locked: false },
    ]);
  });

  it('parses multiple worktrees', () => {
    const output = [
      'worktree /repo\nHEAD abc123\nbranch refs/heads/main',
      'worktree /repo/.worktrees/task-42\nHEAD def456\nbranch refs/heads/task/42-some-slug',
      'worktree /repo/.worktrees/task-99\nHEAD 111222\nbranch refs/heads/task/99-another-slug',
    ].join('\n\n');

    expect(parseWorktreePorcelain(output)).toEqual([
      { path: '/repo', branch: 'main', head: 'abc123', isMain: true, locked: false },
      { path: '/repo/.worktrees/task-42', branch: 'task/42-some-slug', head: 'def456', isMain: false, locked: false },
      { path: '/repo/.worktrees/task-99', branch: 'task/99-another-slug', head: '111222', isMain: false, locked: false },
    ]);
  });

  it('marks detached worktrees with a null branch', () => {
    expect(parseWorktreePorcelain('worktree /repo\nHEAD abc123\ndetached\n')).toEqual([
      { path: '/repo', branch: null, head: 'abc123', isMain: true, locked: false },
    ]);
  });

  it('marks locked worktrees', () => {
    expect(parseWorktreePorcelain('worktree /repo\nHEAD abc123\nbranch refs/heads/main\nlocked\n')).toEqual([
      { path: '/repo', branch: 'main', head: 'abc123', isMain: true, locked: true },
    ]);
  });

  it('returns no entries for empty output', () => {
    expect(parseWorktreePorcelain('')).toEqual([]);
  });
});
