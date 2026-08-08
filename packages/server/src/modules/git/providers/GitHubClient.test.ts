import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import { GitHubClient } from './GitHubClient';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockedExecFileSync = vi.mocked(execFileSync);

describe('GitHubClient token resolution (execFileSync argv safety)', () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset();
  });

  // Access the private getGhToken via the class's public surface indirectly is awkward here,
  // since it's only reachable through async API calls that hit fetch. Exercise it directly
  // via a narrow cast, mirroring how RemoteWorktreeService.test.ts pokes at internals.
  function getGhToken(client: GitHubClient, host: string): string | null {
    return (client as unknown as { getGhToken(host: string): string | null }).getGhToken(host);
  }

  it('passes a shell-metacharacter host as a single argv element, never interpolated into a command string', () => {
    mockedExecFileSync.mockReturnValue('tok123\n' as unknown as string);
    const client = new GitHubClient();
    const maliciousHost = 'a$(id)b';

    const token = getGhToken(client, maliciousHost);

    expect(token).toBe('tok123');
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockedExecFileSync.mock.calls[0];
    expect(cmd).toBe('gh');
    expect(args).toEqual(['auth', 'token', '--hostname', maliciousHost]);
  });

  it.each([';id', '`id`', '$(id)'])('carries metacharacter host %s as a literal argv element', (metaHost) => {
    mockedExecFileSync.mockReturnValue('tok\n' as unknown as string);
    const client = new GitHubClient();

    getGhToken(client, metaHost);

    const [, args] = mockedExecFileSync.mock.calls[0];
    expect(args).toContain(metaHost);
  });

  it('omits --hostname for github.com', () => {
    mockedExecFileSync.mockReturnValue('tok\n' as unknown as string);
    const client = new GitHubClient();

    getGhToken(client, 'github.com');

    const [cmd, args] = mockedExecFileSync.mock.calls[0];
    expect(cmd).toBe('gh');
    expect(args).toEqual(['auth', 'token']);
  });

  it('returns null and does not throw when the gh CLI invocation fails', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('command failed');
    });
    const client = new GitHubClient();

    const token = getGhToken(client, 'github.com');

    expect(token).toBeNull();
  });

  it('caches the result per host, calling execFileSync only once', () => {
    mockedExecFileSync.mockReturnValue('tok\n' as unknown as string);
    const client = new GitHubClient();

    getGhToken(client, 'github.com');
    getGhToken(client, 'github.com');

    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
  });
});
