import { describe, it, expect } from 'vitest';
import {
  assertSafePath,
  assertSafeBranch,
  SAFE_PATH_PATTERN,
  SAFE_BRANCH_PATTERN,
  isFullyQualifiedRef,
  normalizeBranchRef,
} from './assertSafeGitArgs';

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

  it('rejects fully-qualified refs (Issue #87 9th round, Important 1)', () => {
    expect(() => assertSafeBranch('refs/heads/main', 'test')).toThrow(/fully-qualified ref/);
  });

  it('still accepts branch names that merely contain "refs" as a path segment', () => {
    expect(() => assertSafeBranch('feature/refs-cleanup', 'test')).not.toThrow();
  });
});

describe('isFullyQualifiedRef', () => {
  it('detects refs/ prefixed values', () => {
    expect(isFullyQualifiedRef('refs/heads/main')).toBe(true);
    expect(isFullyQualifiedRef('refs/tags/v1')).toBe(true);
  });

  it('does not flag plain branch names', () => {
    expect(isFullyQualifiedRef('main')).toBe(false);
    expect(isFullyQualifiedRef('feature/x')).toBe(false);
  });
});

describe('normalizeBranchRef', () => {
  it('strips a refs/heads/ prefix', () => {
    expect(normalizeBranchRef('refs/heads/main')).toBe('main');
    expect(normalizeBranchRef('refs/heads/feature/x')).toBe('feature/x');
  });

  it('leaves plain branch names unchanged', () => {
    expect(normalizeBranchRef('main')).toBe('main');
    expect(normalizeBranchRef('feature/x')).toBe('feature/x');
  });

  it('makes refs/heads/main and main compare equal (guard normalization)', () => {
    expect(normalizeBranchRef('refs/heads/main')).toBe(normalizeBranchRef('main'));
  });
});
