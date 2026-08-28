import { describe, it, expect } from 'vitest';
import { hasGitError } from './hasGitError';
import type { ExecResult } from '../servers/transport/ServerTransport';

describe('hasGitError', () => {
  // Issue #87 third-party review, fourth pass, Important finding 2:
  // `local`/`agent` transports propagate a real exit code. A failure that
  // never prints a `fatal:`/`error:` line (a shell-level permission error,
  // a missing `git` executable, etc.) must still be detected via `code`.
  it('returns true when code is non-zero and no fatal:/error: text is present (local/agent-shaped failure)', () => {
    const result: ExecResult = { code: 127, stdout: '', stderr: 'bash: git: command not found' };
    expect(hasGitError(result)).toBe(true);
  });

  // `SshClient.execRemote()` always returns `code: 0` and merges (or
  // drops) stderr — the only signal available there is a `fatal:`/`error:`
  // line in the combined text.
  it('returns true when code is 0 but a fatal: line is present (SSH-shaped failure)', () => {
    const result: ExecResult = { code: 0, stdout: 'fatal: not a git repository', stderr: '' };
    expect(hasGitError(result)).toBe(true);
  });

  it('returns false when code is 0 and no fatal:/error: text is present', () => {
    const result: ExecResult = { code: 0, stdout: 'On branch main\nnothing to commit, working tree clean', stderr: '' };
    expect(hasGitError(result)).toBe(false);
  });

  it('returns true when code is non-zero even though stdout/stderr look clean', () => {
    const result: ExecResult = { code: 1, stdout: '', stderr: '' };
    expect(hasGitError(result)).toBe(true);
  });

  it('returns true when an error: line appears mid-text (not just at index 0)', () => {
    const result: ExecResult = { code: 0, stdout: 'Some preamble\nerror: something failed', stderr: '' };
    expect(hasGitError(result)).toBe(true);
  });
});
