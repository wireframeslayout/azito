import { describe, it, expect } from 'vitest';
import { assertSafePath, assertSafeBranch, SAFE_PATH_PATTERN, SAFE_BRANCH_PATTERN } from './assertSafeGitArgs';

describe('assertSafePath', () => {
  it('accepts normal paths', () => {
    expect(() => assertSafePath('/home/user/project', 'test')).not.toThrow();
    expect(() => assertSafePath('~/workspace/repo', 'test')).not.toThrow();
    expect(() => assertSafePath('/home/user/.worktrees/task-1', 'test')).not.toThrow();
  });

  it('rejects $() command substitution', () => {
    expect(() => assertSafePath('/x$(touch /tmp/pwn)', 'test')).toThrow('Unsafe');
  });

  it('rejects backtick command substitution', () => {
    expect(() => assertSafePath('/x`id`', 'test')).toThrow('Unsafe');
  });

  it('rejects single quotes', () => {
    expect(() => assertSafePath("/x'y", 'test')).toThrow('Unsafe');
  });

  it('rejects newlines', () => {
    expect(() => assertSafePath('/x\ny', 'test')).toThrow('Unsafe');
  });

  it('rejects semicolons', () => {
    expect(() => assertSafePath('/x;id', 'test')).toThrow('Unsafe');
  });

  it('rejects pipe', () => {
    expect(() => assertSafePath('/x|id', 'test')).toThrow('Unsafe');
  });

  it('rejects spaces', () => {
    expect(() => assertSafePath('/x y', 'test')).toThrow('Unsafe');
  });
});

describe('assertSafeBranch', () => {
  it('accepts normal branch names', () => {
    expect(() => assertSafeBranch('main', 'test')).not.toThrow();
    expect(() => assertSafeBranch('feature/my-feature', 'test')).not.toThrow();
    expect(() => assertSafeBranch('task/123-fix-bug', 'test')).not.toThrow();
    expect(() => assertSafeBranch('v1.2.3', 'test')).not.toThrow();
  });

  it('rejects ; injection', () => {
    expect(() => assertSafeBranch('main; touch x', 'test')).toThrow('Unsafe');
  });

  it('rejects $() command substitution', () => {
    expect(() => assertSafeBranch('$(id)', 'test')).toThrow('Unsafe');
  });

  it('rejects backticks', () => {
    expect(() => assertSafeBranch('`id`', 'test')).toThrow('Unsafe');
  });

  it('rejects spaces', () => {
    expect(() => assertSafeBranch('my branch', 'test')).toThrow('Unsafe');
  });
});
