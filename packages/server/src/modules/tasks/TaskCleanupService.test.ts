import { describe, it, expect } from 'vitest';

// Import the pattern by re-creating it (it's module-private), or test via the service.
// Since WORKTREE_PATH_PATTERN is not exported, we test the behavior through string matching.
const WORKTREE_PATH_PATTERN = /^[a-zA-Z0-9_./@:~-]+\/\.worktrees\/task-\d+$/;

describe('WORKTREE_PATH_PATTERN', () => {
  it('accepts normal worktree paths', () => {
    expect(WORKTREE_PATH_PATTERN.test('/home/user/project/.worktrees/task-1')).toBe(true);
    expect(WORKTREE_PATH_PATTERN.test('/home/user/my-project/.worktrees/task-123')).toBe(true);
    expect(WORKTREE_PATH_PATTERN.test('~/workspace/repo/.worktrees/task-42')).toBe(true);
  });

  it('rejects $() command substitution', () => {
    expect(WORKTREE_PATH_PATTERN.test('/x$(touch /tmp/pwn)/.worktrees/task-1')).toBe(false);
  });

  it('rejects backtick injection', () => {
    expect(WORKTREE_PATH_PATTERN.test('/x`id`/.worktrees/task-1')).toBe(false);
  });

  it('rejects semicolon injection', () => {
    expect(WORKTREE_PATH_PATTERN.test('/x;id/.worktrees/task-1')).toBe(false);
  });

  it('rejects paths with spaces', () => {
    expect(WORKTREE_PATH_PATTERN.test('/my project/.worktrees/task-1')).toBe(false);
  });

  it('rejects paths not ending with task-N', () => {
    expect(WORKTREE_PATH_PATTERN.test('/home/user/.worktrees/notask')).toBe(false);
  });
});
