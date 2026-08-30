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

describe('GitHubClient.listAccessibleRepositories', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockedExecFileSync.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  function makeRepo(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      owner: { login: 'acme' },
      name: 'widgets',
      clone_url: 'https://github.com/acme/widgets.git',
      default_branch: 'main',
      private: false,
      pushed_at: '2026-01-01T00:00:00Z',
      ...overrides,
    };
  }

  function jsonResponse(body: unknown) {
    return { ok: true, json: async () => body, text: async () => '' };
  }

  it('maps fields and requests the expected affiliation/sort params (explicit token, no gh CLI fallback)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([makeRepo()]));
    const client = new GitHubClient();

    const result = await client.listAccessibleRepositories('explicit-token');

    expect(mockedExecFileSync).not.toHaveBeenCalled();
    expect(result.truncated).toBe(false);
    expect(result.repositories).toEqual([
      {
        provider: 'github',
        owner: 'acme',
        repoName: 'widgets',
        httpsUrl: 'https://github.com/acme/widgets.git',
        defaultBranch: 'main',
        private: false,
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/user/repos?');
    expect(url).toContain('affiliation=owner%2Ccollaborator%2Corganization_member');
    expect(url).toContain('sort=pushed');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer explicit-token');
  });

  it('never leaks the token into the returned repository summaries', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([makeRepo()]));
    const client = new GitHubClient();

    const result = await client.listAccessibleRepositories('super-secret-token');

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('super-secret-token');
  });

  it('stops paging at the page cap and reports truncated when a full page is returned at the cap', async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) => makeRepo({ name: `repo-${i}` }));
    fetchMock.mockResolvedValueOnce(jsonResponse(fullPage)); // page 1: full
    fetchMock.mockResolvedValueOnce(jsonResponse(fullPage)); // page 2 (cap): full again
    const client = new GitHubClient();

    const result = await client.listAccessibleRepositories('tok');

    expect(fetchMock).toHaveBeenCalledTimes(2); // never fetches a 3rd page
    expect(result.repositories).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });

  it('stops paging and reports not truncated once a short page is returned', async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) => makeRepo({ name: `repo-${i}` }));
    const shortPage = [makeRepo({ name: 'last-one' })];
    fetchMock.mockResolvedValueOnce(jsonResponse(fullPage));
    fetchMock.mockResolvedValueOnce(jsonResponse(shortPage));
    const client = new GitHubClient();

    const result = await client.listAccessibleRepositories('tok');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.repositories).toHaveLength(51);
    expect(result.truncated).toBe(false);
  });

  it('propagates a provider API failure as a thrown error rather than an empty success result', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Bad credentials' });
    const client = new GitHubClient();

    await expect(client.listAccessibleRepositories('bad-token')).rejects.toThrow(/401/);
  });
});
