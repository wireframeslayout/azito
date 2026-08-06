import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import { GitLabClient } from './GitLabClient';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockedExecFileSync = vi.mocked(execFileSync);

describe('GitLabClient token resolution (execFileSync argv safety)', () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset();
  });

  function getGlabToken(client: GitLabClient, host: string): string | null {
    return (client as unknown as { getGlabToken(host: string): string | null }).getGlabToken(host);
  }

  it('passes a shell-metacharacter host as a single argv element, never interpolated into a command string', () => {
    mockedExecFileSync.mockReturnValue('tok123\n' as unknown as string);
    const client = new GitLabClient();
    const maliciousHost = 'a$(id)b';

    const token = getGlabToken(client, maliciousHost);

    expect(token).toBe('tok123');
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockedExecFileSync.mock.calls[0];
    expect(cmd).toBe('glab');
    expect(args).toEqual(['config', 'get', 'token', '-h', maliciousHost]);
  });

  it.each(['evil;id', '`id`', '$(id)'])('carries metacharacter host %s as a literal argv element', (metaHost) => {
    mockedExecFileSync.mockReturnValue('tok\n' as unknown as string);
    const client = new GitLabClient();

    getGlabToken(client, metaHost);

    const [, args] = mockedExecFileSync.mock.calls[0];
    expect(args).toContain(metaHost);
  });

  it('returns null and does not throw when the glab CLI invocation fails', () => {
    mockedExecFileSync.mockImplementation(() => {
      throw new Error('command failed');
    });
    const client = new GitLabClient();

    const token = getGlabToken(client, 'gitlab.com');

    expect(token).toBeNull();
  });

  it('caches the result per host, calling execFileSync only once', () => {
    mockedExecFileSync.mockReturnValue('tok\n' as unknown as string);
    const client = new GitLabClient();

    getGlabToken(client, 'gitlab.com');
    getGlabToken(client, 'gitlab.com');

    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
  });
});
