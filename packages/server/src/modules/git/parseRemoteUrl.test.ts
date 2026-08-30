import { describe, it, expect } from 'vitest';
import { parseRemoteUrl, normalizeRemoteUrl } from './parseRemoteUrl';

describe('parseRemoteUrl', () => {
  it('parses GitHub HTTPS URL', () => {
    const result = parseRemoteUrl('https://github.com/octocat/hello-world.git');
    expect(result).toEqual({ provider: 'github', owner: 'octocat', repoName: 'hello-world', host: 'github.com' });
  });

  it('parses GitHub HTTPS URL without .git suffix', () => {
    const result = parseRemoteUrl('https://github.com/octocat/hello-world');
    expect(result).toEqual({ provider: 'github', owner: 'octocat', repoName: 'hello-world', host: 'github.com' });
  });

  it('parses GitHub SSH URL', () => {
    const result = parseRemoteUrl('git@github.com:octocat/hello-world.git');
    expect(result).toEqual({ provider: 'github', owner: 'octocat', repoName: 'hello-world', host: 'github.com' });
  });

  it('parses GitLab HTTPS URL', () => {
    const result = parseRemoteUrl('https://gitlab.com/group/subgroup/repo.git');
    expect(result).toEqual({ provider: 'gitlab', owner: 'group/subgroup', repoName: 'repo', host: 'gitlab.com' });
  });

  it('parses self-hosted GitLab URL', () => {
    const result = parseRemoteUrl('https://gitlab.example.com/team/project.git');
    expect(result).toEqual({ provider: 'gitlab', owner: 'team', repoName: 'project', host: 'gitlab.example.com' });
  });

  it('parses GitLab SSH URL', () => {
    const result = parseRemoteUrl('git@gitlab.com:owner/repo.git');
    expect(result).toEqual({ provider: 'gitlab', owner: 'owner', repoName: 'repo', host: 'gitlab.com' });
  });

  it('parses generic HTTPS URL as other', () => {
    const result = parseRemoteUrl('https://bitbucket.org/owner/repo.git');
    expect(result).toEqual({ provider: 'other', owner: 'owner', repoName: 'repo', host: 'bitbucket.org' });
  });

  it('parses SSH protocol URL', () => {
    const result = parseRemoteUrl('ssh://git@example.com:2222/owner/repo.git');
    expect(result).toEqual({ provider: 'other', owner: 'owner', repoName: 'repo', host: 'example.com' });
  });

  it('returns other with nulls for unparseable URL', () => {
    const result = parseRemoteUrl('not-a-url');
    expect(result).toEqual({ provider: 'other', owner: null, repoName: null, host: null });
  });
});

describe('normalizeRemoteUrl', () => {
  it('normalizes HTTPS and SSH to same form', () => {
    const https = normalizeRemoteUrl('https://github.com/owner/repo.git');
    const ssh = normalizeRemoteUrl('git@github.com:owner/repo.git');
    expect(https).toBe(ssh);
  });

  it('removes trailing slash', () => {
    expect(normalizeRemoteUrl('https://github.com/owner/repo/')).toBe('github.com/owner/repo');
  });

  it('removes .git suffix', () => {
    expect(normalizeRemoteUrl('https://github.com/owner/repo.git')).toBe('github.com/owner/repo');
  });

  it('lowercases only the hostname, not the path', () => {
    expect(normalizeRemoteUrl('https://GitHub.com/Owner/Repo')).toBe('github.com/Owner/Repo');
  });

  it('preserves a non-default port', () => {
    const result = normalizeRemoteUrl('ssh://git@example.com:2222/owner/repo.git');
    expect(result).toBe('example.com:2222/owner/repo');
  });

  it('drops the default port for the scheme', () => {
    expect(normalizeRemoteUrl('https://github.com:443/owner/repo.git')).toBe('github.com/owner/repo');
    expect(normalizeRemoteUrl('ssh://git@example.com:22/owner/repo.git')).toBe('example.com/owner/repo');
  });

  it('treats different ports as different identities', () => {
    const a = normalizeRemoteUrl('ssh://git@example.com:2222/owner/repo.git');
    const b = normalizeRemoteUrl('ssh://git@example.com:2223/owner/repo.git');
    expect(a).not.toBe(b);
  });

  it('treats different path casing as different identities on a case-sensitive host', () => {
    const a = normalizeRemoteUrl('https://example.com/Owner/Repo.git');
    const b = normalizeRemoteUrl('https://example.com/owner/repo.git');
    expect(a).not.toBe(b);
  });

  it('normalizes trailing .git and trailing slash to the same identity', () => {
    const withGit = normalizeRemoteUrl('https://github.com/owner/repo.git');
    const withSlash = normalizeRemoteUrl('https://github.com/owner/repo/');
    expect(withGit).toBe(withSlash);
  });

  it('normalizes scp-like and https forms to the same identity, case-sensitive path preserved', () => {
    const https = normalizeRemoteUrl('https://github.com/owner/Repo.git');
    const scp = normalizeRemoteUrl('git@github.com:owner/Repo.git');
    expect(https).toBe(scp);
  });
});
