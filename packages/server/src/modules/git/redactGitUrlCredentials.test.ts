import { describe, it, expect } from 'vitest';
import { redactGitUrlCredentials } from './redactGitUrlCredentials';

describe('redactGitUrlCredentials', () => {
  it('strips a username:password pair from an https URL', () => {
    expect(redactGitUrlCredentials('https://user:token@host/x.git')).toBe('https://host/x.git');
  });

  it('strips a username-only credential from an https URL', () => {
    expect(redactGitUrlCredentials('https://user@host/x.git')).toBe('https://host/x.git');
  });

  it('never contains the dummy credential value anywhere in the output', () => {
    const result = redactGitUrlCredentials('https://x-access-token:ghp_DUMMYTOKENVALUE1234@github.com/owner/repo.git');
    expect(result).not.toContain('ghp_DUMMYTOKENVALUE1234');
    expect(result).not.toContain('x-access-token');
    expect(result).toBe('https://github.com/owner/repo.git');
  });

  it('leaves a credential-free https URL unchanged (aside from URL normalization)', () => {
    expect(redactGitUrlCredentials('https://github.com/owner/repo.git')).toBe('https://github.com/owner/repo.git');
  });

  it('strips credentials from an ssh:// URL without breaking the host/path', () => {
    expect(redactGitUrlCredentials('ssh://user:secret@host.example.com:2222/owner/repo.git'))
      .toBe('ssh://host.example.com:2222/owner/repo.git');
  });

  it('strips a bare user@ from an ssh:// URL with no password', () => {
    expect(redactGitUrlCredentials('ssh://git@host.example.com/owner/repo.git'))
      .toBe('ssh://host.example.com/owner/repo.git');
  });

  it('strips the user@ prefix from scp-like syntax without mangling the rest', () => {
    expect(redactGitUrlCredentials('git@github.com:owner/repo.git')).toBe('github.com:owner/repo.git');
  });

  it('leaves scp-like syntax with no user@ prefix unchanged', () => {
    expect(redactGitUrlCredentials('github.com:owner/repo.git')).toBe('github.com:owner/repo.git');
  });

  it('returns a safe placeholder for an empty string', () => {
    expect(redactGitUrlCredentials('')).toBe('(empty)');
    expect(redactGitUrlCredentials('   ')).toBe('(empty)');
  });

  it('returns a safe placeholder instead of throwing on garbage after a scheme', () => {
    expect(() => redactGitUrlCredentials('https://')).not.toThrow();
    expect(redactGitUrlCredentials('https://')).toMatch(/unparseable|https:/);
  });

  it('never throws for arbitrary unparseable input', () => {
    expect(() => redactGitUrlCredentials('not a url at all $(rm -rf /)')).not.toThrow();
  });

  it('strips a query string that carries a token, in addition to userinfo', () => {
    const result = redactGitUrlCredentials('https://user:token@host/owner/repo.git?token=ghp_DUMMYTOKENVALUE1234&foo=bar');
    expect(result).toBe('https://host/owner/repo.git');
    expect(result).not.toContain('ghp_DUMMYTOKENVALUE1234');
    expect(result).not.toContain('token=');
  });

  it('strips a query string with no embedded userinfo', () => {
    expect(redactGitUrlCredentials('https://github.com/owner/repo.git?token=ghp_DUMMYTOKENVALUE1234'))
      .toBe('https://github.com/owner/repo.git');
  });

  it('strips a fragment that could carry credential-shaped data', () => {
    expect(redactGitUrlCredentials('https://user:token@host/owner/repo.git#access_token=ghp_DUMMYTOKENVALUE1234'))
      .toBe('https://host/owner/repo.git');
  });

  it('strips both query and fragment together', () => {
    const result = redactGitUrlCredentials('https://user:token@host/owner/repo.git?token=ghp_DUMMYTOKENVALUE1234#frag=1');
    expect(result).toBe('https://host/owner/repo.git');
    expect(result).not.toContain('ghp_DUMMYTOKENVALUE1234');
    expect(result).not.toContain('frag');
  });

  describe('scheme-less inputs that previously leaked credentials (Issue #87)', () => {
    it('strips a query-string token from a bare scp-like host:path', () => {
      const result = redactGitUrlCredentials('github.com:owner/repo.git?token=ghp_DUMMYSECRET1');
      expect(result).not.toContain('ghp_DUMMYSECRET1');
      expect(result).not.toContain('SECRET1');
      expect(result).toBe('github.com:owner/repo.git');
    });

    it('strips a query-string token from a user@ scp-like remote', () => {
      const result = redactGitUrlCredentials('git@github.com:o/r.git?token=ghp_DUMMYSECRET2');
      expect(result).not.toContain('ghp_DUMMYSECRET2');
      expect(result).not.toContain('SECRET2');
      expect(result).toBe('github.com:o/r.git');
    });

    it('returns a safe placeholder instead of echoing unstructured garbage', () => {
      const result = redactGitUrlCredentials('some-garbage token=ghp_DUMMYSECRET3');
      expect(result).not.toContain('ghp_DUMMYSECRET3');
      expect(result).not.toContain('SECRET3');
      expect(result).toBe('(unrecognized origin url)');
    });

    it('returns a safe placeholder instead of echoing a local path with a token suffix', () => {
      const result = redactGitUrlCredentials('/local/path?token=ghp_DUMMYSECRET4');
      expect(result).not.toContain('ghp_DUMMYSECRET4');
      expect(result).not.toContain('SECRET4');
      expect(result).toBe('(unrecognized origin url)');
    });
  });

  describe('normal-path outputs remain unchanged (Issue #87 regression guard)', () => {
    it('leaves a plain https URL unchanged', () => {
      expect(redactGitUrlCredentials('https://github.com/o/r.git')).toBe('https://github.com/o/r.git');
    });

    it('leaves a plain ssh:// URL unchanged', () => {
      expect(redactGitUrlCredentials('ssh://github.com:22/o/r.git')).toBe('ssh://github.com:22/o/r.git');
    });

    it('leaves a plain scp-like remote unchanged', () => {
      expect(redactGitUrlCredentials('github.com:o/r.git')).toBe('github.com:o/r.git');
    });

    it('still redacts an https URL carrying credentials', () => {
      expect(redactGitUrlCredentials('https://user:ghp_DUMMYSECRET5@github.com/o/r.git'))
        .toBe('https://github.com/o/r.git');
    });
  });
});
