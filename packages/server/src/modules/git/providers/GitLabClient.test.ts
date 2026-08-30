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

describe('GitLabClient.listAccessibleRepositories', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockedExecFileSync.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  function makeProject(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      path_with_namespace: 'acme/widgets',
      name: 'widgets',
      http_url_to_repo: 'https://gitlab.com/acme/widgets.git',
      default_branch: 'main',
      visibility: 'private',
      last_activity_at: '2026-01-01T00:00:00Z',
      ...overrides,
    };
  }

  function jsonResponse(body: unknown) {
    return { ok: true, json: async () => body, text: async () => '' };
  }

  it('maps fields and requests membership/order_by params (explicit token, no glab CLI fallback)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([makeProject()]));
    const client = new GitLabClient();

    const result = await client.listAccessibleRepositories('explicit-token');

    expect(mockedExecFileSync).not.toHaveBeenCalled();
    expect(result.truncated).toBe(false);
    expect(result.repositories).toEqual([
      {
        provider: 'gitlab',
        owner: 'acme',
        repoName: 'widgets',
        httpsUrl: 'https://gitlab.com/acme/widgets.git',
        defaultBranch: 'main',
        private: true,
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/projects?');
    expect(url).toContain('membership=true');
    expect(url).toContain('order_by=last_activity_at');
    expect((init.headers as Record<string, string>)['PRIVATE-TOKEN']).toBe('explicit-token');
  });

  it('handles a nested group namespace (owner keeps the full group path)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([makeProject({ path_with_namespace: 'group/subgroup/widgets' })]));
    const client = new GitLabClient();

    const result = await client.listAccessibleRepositories('tok');

    expect(result.repositories[0].owner).toBe('group/subgroup');
    expect(result.repositories[0].repoName).toBe('widgets');
  });

  it('never leaks the token into the returned repository summaries', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([makeProject()]));
    const client = new GitLabClient();

    const result = await client.listAccessibleRepositories('super-secret-token');

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('super-secret-token');
  });

  it('stops paging at the page cap and reports truncated when a full page is returned at the cap', async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) => makeProject({ path_with_namespace: `acme/repo-${i}` }));
    fetchMock.mockResolvedValueOnce(jsonResponse(fullPage));
    fetchMock.mockResolvedValueOnce(jsonResponse(fullPage));
    const client = new GitLabClient();

    const result = await client.listAccessibleRepositories('tok');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.repositories).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });

  it('propagates a provider API failure as a thrown error rather than an empty success result', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' });
    const client = new GitLabClient();

    await expect(client.listAccessibleRepositories('bad-token')).rejects.toThrow(/401/);
  });
});
