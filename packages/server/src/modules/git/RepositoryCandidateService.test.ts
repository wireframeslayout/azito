import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RepositoryCandidateService } from './RepositoryCandidateService';
import type { IProjectRepository, ProjectDetail } from '../projects/Project';
import type { GitProviderService } from './providers/GitProviderService';
import type { ListAccessibleRepositoriesResult } from './providers/types';

function makeProjectDetail(overrides: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    id: 1,
    name: 'Test Project',
    slug: 'test-project',
    description: null,
    repositoryUrl: null,
    defaultBranch: null,
    sidekickPrompt: null,
    icon: null,
    color: null,
    defaultUnitId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    repositories: [],
    windows: [],
    ...overrides,
  };
}

function makeProjectRepo(findAllResult: ProjectDetail[]): IProjectRepository {
  return {
    findAll: vi.fn(() => findAllResult),
    findById: vi.fn(() => null),
    create: vi.fn(() => 1),
    update: vi.fn(),
    delete: vi.fn(),
    addRepository: vi.fn(() => 1),
    updateRepositoryToken: vi.fn(),
    findRepositoryById: vi.fn(() => null),
    removeRepository: vi.fn(),
  };
}

function makeGitProvider(impl: (provider: 'github' | 'gitlab') => Promise<ListAccessibleRepositoriesResult>): GitProviderService {
  return {
    listAccessibleRepositories: vi.fn((provider: 'github' | 'gitlab') => impl(provider)),
  } as unknown as GitProviderService;
}

describe('RepositoryCandidateService', () => {
  let gitProviderCalls: ('github' | 'gitlab')[];

  beforeEach(() => {
    gitProviderCalls = [];
  });

  it('merges registered and provider candidates, deduplicating by normalized URL with registered taking priority', async () => {
    const projectRepo = makeProjectRepo([
      makeProjectDetail({
        repositories: [
          {
            id: 10,
            name: null,
            url: 'https://github.com/acme/widgets.git',
            provider: 'github',
            owner: 'acme',
            repoName: 'widgets',
            hasToken: true,
          },
        ],
      }),
    ]);
    const gitProvider = makeGitProvider(async (provider) => {
      gitProviderCalls.push(provider);
      if (provider === 'github') {
        return {
          truncated: false,
          repositories: [
            // Same repo as the registered one (scp-like form) — must be deduped, registered wins.
            {
              provider: 'github', owner: 'acme', repoName: 'widgets',
              httpsUrl: 'git@github.com:acme/widgets.git', defaultBranch: 'main', private: false, updatedAt: 'x',
            },
            // A distinct repo, provider-only.
            {
              provider: 'github', owner: 'acme', repoName: 'gadgets',
              httpsUrl: 'https://github.com/acme/gadgets.git', defaultBranch: 'main', private: false, updatedAt: 'x',
            },
          ],
        };
      }
      return { truncated: false, repositories: [] };
    });

    const service = new RepositoryCandidateService(projectRepo, gitProvider);
    const result = await service.listCandidates({});

    expect(result.candidates).toHaveLength(2);
    const widgets = result.candidates.find((c) => c.repoName === 'widgets');
    expect(widgets?.source).toBe('registered');
    expect(widgets?.hasToken).toBe(true);
    const gadgets = result.candidates.find((c) => c.repoName === 'gadgets');
    expect(gadgets?.source).toBe('provider');
    expect(result.providerErrors).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('filters by q on owner/repoName, case-insensitively', async () => {
    const projectRepo = makeProjectRepo([
      makeProjectDetail({
        repositories: [
          { id: 1, name: null, url: 'https://github.com/acme/widgets.git', provider: 'github', owner: 'acme', repoName: 'widgets', hasToken: false },
          { id: 2, name: null, url: 'https://github.com/acme/other.git', provider: 'github', owner: 'acme', repoName: 'other', hasToken: false },
        ],
      }),
    ]);
    const gitProvider = makeGitProvider(async () => ({ truncated: false, repositories: [] }));

    const service = new RepositoryCandidateService(projectRepo, gitProvider);
    const result = await service.listCandidates({ q: 'WIDGE' });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].repoName).toBe('widgets');
  });

  it('sets truncated when candidates exceed the cap, without silently dropping the flag', async () => {
    const repos = Array.from({ length: 60 }, (_, i) => ({
      id: i,
      name: null,
      url: `https://github.com/acme/repo-${i}.git`,
      provider: 'github' as const,
      owner: 'acme',
      repoName: `repo-${i}`,
      hasToken: false,
    }));
    const projectRepo = makeProjectRepo([makeProjectDetail({ repositories: repos })]);
    const gitProvider = makeGitProvider(async () => ({ truncated: false, repositories: [] }));

    const service = new RepositoryCandidateService(projectRepo, gitProvider);
    const result = await service.listCandidates({});

    expect(result.candidates).toHaveLength(50);
    expect(result.truncated).toBe(true);
  });

  it('still returns registered candidates and reports providerError when the provider API fails', async () => {
    const projectRepo = makeProjectRepo([
      makeProjectDetail({
        repositories: [
          { id: 1, name: null, url: 'https://github.com/acme/widgets.git', provider: 'github', owner: 'acme', repoName: 'widgets', hasToken: false },
        ],
      }),
    ]);
    const gitProvider = makeGitProvider(async (provider) => {
      if (provider === 'github') throw new Error('GitHub API 401: Bad credentials');
      return { truncated: false, repositories: [] };
    });

    const service = new RepositoryCandidateService(projectRepo, gitProvider);
    const result = await service.listCandidates({});

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].source).toBe('registered');
    expect(result.providerErrors).toEqual([{ provider: 'github', message: 'GitHub API 401: Bad credentials' }]);
  });

  it('never includes a token in the response', async () => {
    const projectRepo = makeProjectRepo([
      makeProjectDetail({
        repositories: [
          { id: 1, name: null, url: 'https://github.com/acme/widgets.git', provider: 'github', owner: 'acme', repoName: 'widgets', hasToken: true },
        ],
      }),
    ]);
    const gitProvider = makeGitProvider(async () => ({ truncated: false, repositories: [] }));

    const service = new RepositoryCandidateService(projectRepo, gitProvider);
    const result = await service.listCandidates({});

    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/"token"/);
    expect(result.candidates[0]).not.toHaveProperty('token');
    expect(result.candidates[0].hasToken).toBe(true);
  });

  it('caches provider results for repeated calls within the TTL (no repeated external calls)', async () => {
    const projectRepo = makeProjectRepo([makeProjectDetail()]);
    const fetchSpy = vi.fn(async () => ({ truncated: false, repositories: [] }));
    const gitProvider = makeGitProvider(fetchSpy);

    const service = new RepositoryCandidateService(projectRepo, gitProvider);
    await service.listCandidates({});
    await service.listCandidates({});

    // Each call queries both github and gitlab; caching should prevent doubling on the 2nd listCandidates() call.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('only queries the requested provider when a specific provider filter is given', async () => {
    const projectRepo = makeProjectRepo([makeProjectDetail()]);
    const gitProvider = makeGitProvider(async (provider) => {
      gitProviderCalls.push(provider);
      return { truncated: false, repositories: [] };
    });

    const service = new RepositoryCandidateService(projectRepo, gitProvider);
    await service.listCandidates({ provider: 'github' });

    expect(gitProviderCalls).toEqual(['github']);
  });

  it('on dedupe conflict, keeps the registered candidate\'s source/hasToken but merges defaultBranch/private/updatedAt from the provider', async () => {
    const projectRepo = makeProjectRepo([
      makeProjectDetail({
        repositories: [
          // Registered candidates never carry defaultBranch/private/updatedAt (always null in the DB row).
          { id: 10, name: null, url: 'https://github.com/acme/widgets.git', provider: 'github', owner: 'acme', repoName: 'widgets', hasToken: true },
        ],
      }),
    ]);
    const gitProvider = makeGitProvider(async (provider) => {
      if (provider === 'github') {
        return {
          truncated: false,
          repositories: [
            {
              provider: 'github', owner: 'acme', repoName: 'widgets',
              httpsUrl: 'https://github.com/acme/widgets.git', defaultBranch: 'develop', private: true, updatedAt: '2026-08-01T00:00:00Z',
            },
          ],
        };
      }
      return { truncated: false, repositories: [] };
    });

    const service = new RepositoryCandidateService(projectRepo, gitProvider);
    const result = await service.listCandidates({});

    expect(result.candidates).toHaveLength(1);
    const widgets = result.candidates[0];
    // Kept from the registered side.
    expect(widgets.source).toBe('registered');
    expect(widgets.hasToken).toBe(true);
    // Merged in from the provider side, instead of staying null.
    expect(widgets.defaultBranch).toBe('develop');
    expect(widgets.private).toBe(true);
    expect(widgets.updatedAt).toBe('2026-08-01T00:00:00Z');
  });

  it('keeps hasToken: true when the same repository is registered in two projects and findAll() returns the newer (tokenless) one first', async () => {
    // Regression: projectRepo.findAll() returns projects newest-first. A prior fix that
    // synthesizes provider metadata onto registered candidates also made the registered-vs-
    // registered dedupe loop overwrite unconditionally, so a newer duplicate with hasToken:
    // false could clobber an older duplicate's hasToken: true. Must not regress to "last write
    // wins" among registered candidates themselves.
    const projectRepo = makeProjectRepo([
      makeProjectDetail({
        id: 2,
        repositories: [
          { id: 20, name: null, url: 'https://github.com/acme/widgets.git', provider: 'github', owner: 'acme', repoName: 'widgets', hasToken: false },
        ],
      }),
      makeProjectDetail({
        id: 1,
        repositories: [
          { id: 10, name: null, url: 'https://github.com/acme/widgets.git', provider: 'github', owner: 'acme', repoName: 'widgets', hasToken: true },
        ],
      }),
    ]);
    const gitProvider = makeGitProvider(async () => ({ truncated: false, repositories: [] }));

    const service = new RepositoryCandidateService(projectRepo, gitProvider);
    const result = await service.listCandidates({});

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].hasToken).toBe(true);
  });

  it('propagates a provider-side truncation even when the result is well under the local 50-item cap', async () => {
    const projectRepo = makeProjectRepo([makeProjectDetail()]);
    const gitProvider = makeGitProvider(async (provider) => {
      if (provider === 'github') {
        return {
          truncated: true, // provider itself hit its page cap
          repositories: [
            { provider: 'github', owner: 'acme', repoName: 'widgets', httpsUrl: 'https://github.com/acme/widgets.git', defaultBranch: 'main', private: false, updatedAt: 'x' },
          ],
        };
      }
      return { truncated: false, repositories: [] };
    });

    const service = new RepositoryCandidateService(projectRepo, gitProvider);
    const result = await service.listCandidates({});

    expect(result.candidates).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('still reports truncated after a q-filter shrinks the result below 50, when the provider itself was truncated', async () => {
    const projectRepo = makeProjectRepo([makeProjectDetail()]);
    const gitProvider = makeGitProvider(async (provider) => {
      if (provider === 'github') {
        return {
          truncated: true,
          repositories: [
            { provider: 'github', owner: 'acme', repoName: 'widgets', httpsUrl: 'https://github.com/acme/widgets.git', defaultBranch: 'main', private: false, updatedAt: 'x' },
            { provider: 'github', owner: 'acme', repoName: 'gadgets', httpsUrl: 'https://github.com/acme/gadgets.git', defaultBranch: 'main', private: false, updatedAt: 'x' },
          ],
        };
      }
      return { truncated: false, repositories: [] };
    });

    const service = new RepositoryCandidateService(projectRepo, gitProvider);
    const result = await service.listCandidates({ q: 'widgets' });

    // The q-filter alone drops the result to 1 item (well under the 50-item cap), so a naive
    // `filtered.length > MAX_CANDIDATES` check would report truncated: false here.
    expect(result.candidates).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });
});
