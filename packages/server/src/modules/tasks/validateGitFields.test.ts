import { describe, it, expect } from 'vitest';
import { validateGitFields } from './routes';

describe('validateGitFields', () => {
  it('accepts normal branch names, including ones containing slashes', () => {
    expect(validateGitFields({ branch: 'main' }, null)).toBeNull();
    expect(validateGitFields({ branch: 'feature/x' }, null)).toBeNull();
    expect(validateGitFields({ base_branch: 'task/123-fix-bug' }, null)).toBeNull();
    expect(validateGitFields({ target_branch: 'release/v1.2.3' }, null)).toBeNull();
  });

  it('rejects a fully-qualified ref in branch (Issue #87 9th round, Important 1)', () => {
    expect(validateGitFields({ branch: 'refs/heads/main' }, null)).toMatch(/branch/);
  });

  it('rejects a fully-qualified ref in base_branch', () => {
    expect(validateGitFields({ base_branch: 'refs/heads/main' }, null)).toMatch(/base_branch/);
  });

  it('rejects a fully-qualified ref in target_branch', () => {
    expect(validateGitFields({ target_branch: 'refs/heads/main' }, null)).toMatch(/target_branch/);
  });

  it('rejects other unsafe branch characters as before', () => {
    expect(validateGitFields({ branch: 'main; touch x' }, null)).toMatch(/Invalid branch/);
  });

  it('ignores null/empty branch fields', () => {
    expect(validateGitFields({ branch: null, base_branch: '', target_branch: undefined }, null)).toBeNull();
  });

  // Issue #87 third-party review, 10th round, Important finding 1: origin/-prefixed
  // input must be rejected at creation time, since resolveWorktreeCreateBaseBranch
  // unconditionally prepends origin/ once distribution has run, which would
  // otherwise resolve to the nonexistent ref origin/origin/main.
  it('rejects a remote-qualified branch in base_branch', () => {
    expect(validateGitFields({ base_branch: 'origin/main' }, null)).toMatch(/base_branch/);
  });

  it('rejects a remote-qualified branch in branch', () => {
    expect(validateGitFields({ branch: 'origin/feature-x' }, null)).toMatch(/branch/);
  });

  it('rejects a remote-qualified branch in target_branch', () => {
    expect(validateGitFields({ target_branch: 'origin/main' }, null)).toMatch(/target_branch/);
  });

  describe('working_directory / worktree_path', () => {
    it('accepts absolute paths of the server OS (win32 also with spaces and Japanese)', () => {
      expect(validateGitFields({ working_directory: '/home/me/repo' }, 'linux')).toBeNull();
      expect(validateGitFields({ worktree_path: '/home/me/repo/.worktrees/task-1' }, 'darwin')).toBeNull();
      expect(validateGitFields({ working_directory: 'C:\\Users\\me\\My Repo' }, 'win32')).toBeNull();
      expect(validateGitFields({ worktree_path: 'D:/work/日本語' }, 'win32')).toBeNull();
      expect(validateGitFields({ working_directory: '~/work' }, 'linux')).toBeNull();
      expect(validateGitFields({ working_directory: '~\\work' }, 'win32')).toBeNull();
    });

    it('rejects a path that is not valid on the server OS', () => {
      expect(validateGitFields({ working_directory: 'C:\\x' }, 'linux')).toMatch(/working_directory/);
      expect(validateGitFields({ working_directory: '/home/me' }, 'win32')).toMatch(/drive/);
      expect(validateGitFields({ working_directory: 'relative/dir' }, 'linux')).toMatch(/absolute/);
      expect(validateGitFields({ working_directory: 'C:foo' }, 'win32')).toMatch(/drive-relative/);
      expect(validateGitFields({ worktree_path: '\\\\.\\pipe\\x' }, 'win32')).toMatch(/worktree_path/);
      expect(validateGitFields({ working_directory: '~\\x' }, 'linux')).toMatch(/absolute/);
    });

    it('on POSIX still refuses spaces and non-ASCII until R3 / R4 (the git side keeps SAFE_PATH)', () => {
      expect(validateGitFields({ working_directory: '/home/me/my repo' }, 'linux')).toMatch(/only letters/);
      expect(validateGitFields({ worktree_path: '/home/me/プロジェクト' }, 'darwin')).toMatch(/worktree_path/);
    });

    it('refuses control characters on every OS', () => {
      for (const platform of ['linux', 'win32', null] as const) {
        const base = platform === 'win32' ? 'C:\\repo' : '/repo';
        for (const ch of ['\n', '\r', '\x15']) {
          expect(validateGitFields({ working_directory: base + ch + 'x' }, platform)).toMatch(/control character/);
        }
      }
    });

    it('rejects a non-string value', () => {
      expect(validateGitFields({ working_directory: 5 }, 'linux')).toBe('Invalid working_directory');
    });

    it('ignores null / empty (unset)', () => {
      expect(validateGitFields({ working_directory: null, worktree_path: '' }, 'linux')).toBeNull();
    });

    it('with an unknown server, accepts a path valid on any OS and rejects one valid on none', () => {
      expect(validateGitFields({ working_directory: '/srv/repo' }, null)).toBeNull();
      expect(validateGitFields({ working_directory: 'C:\\Users\\me' }, null)).toBeNull();
      expect(validateGitFields({ working_directory: 'relative' }, null)).not.toBeNull();
      expect(validateGitFields({ working_directory: 'a\0b' }, null)).toMatch(/NUL/);
    });
  });
});
