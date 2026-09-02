import { describe, it, expect, vi } from 'vitest';
import { PushNotaryService } from './PushNotaryService';

function mockRemoteBundleOps(overrides: Partial<Record<string, any>> = {}) {
  return {
    getHeadSha: vi.fn(async () => 'a'.repeat(40)),
    createFromWorktree: vi.fn(async () => '/tmp/azito-push-test.bundle'),
    cleanup: vi.fn(async () => {}),
    ...overrides,
  } as any;
}

function mockSftpService() {
  return { download: vi.fn(async () => {}) } as any;
}

function mockCleanPusher(sha = 'a'.repeat(40)) {
  return { push: vi.fn(() => ({ pushedSha: sha })) } as any;
}

function mockGitProvider(remoteSha: string | null = null) {
  return { getBranchHeadSha: vi.fn(async () => remoteSha) } as any;
}

function mockHubRepoCache() {
  return {
    ensureFetched: vi.fn(() => 'a'.repeat(40)),
    getRepoCacheDir: vi.fn(() => '/fake/repo-cache'),
  } as any;
}

const makeServer = (overrides: Record<string, any> = {}): import('../../servers/Server').ServerConfig => ({
  name: 'test-server',
  type: 'agent',
  host: '100.64.0.2',
  agentPort: 4001,
  agentToken: 'test-token',
  agentVersion: null,
  sshHost: 'user@host',
  muxRuntime: 'system',
  sshHostFingerprint: null,
  isolationIntent: true,
  isolationVerifiedAt: null,
  isolationReport: null,
  isolationCleanupReport: null,
  createdAt: '2026-01-01T00:00:00Z',
  ...overrides,
});

const makeRepo = (overrides: Record<string, any> = {}): import('../../projects/Project').ProjectRepositoryWithToken => ({
  id: 1,
  name: 'origin',
  provider: 'github',
  url: 'https://github.com/owner/repo.git',
  owner: 'owner',
  repoName: 'repo',
  token: 'ghp_test',
  ...overrides,
});

describe('PushNotaryService', () => {
  const sha = 'a'.repeat(40);

  it('returns failed when sshHost is missing', async () => {
    const service = new PushNotaryService(mockRemoteBundleOps(), mockSftpService(), mockCleanPusher(), mockGitProvider(), mockHubRepoCache());
    const result = await service.notarize({
      taskId: 1, unitId: 1, server: makeServer({ sshHost: null }) as any,
      transport: {} as any, worktreePath: '/wt', branch: 'feat', baseBranch: 'main', repo: makeRepo(), token: 'ghp_test',
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('sshHost');
  });

  // The caller (PhaseLoopRunner) resolves the credential and owns the
  // "no credential at all" verdict; an empty token arriving here is a wiring
  // bug and must fail loudly rather than push anonymously (Issue #87).
  it('returns failed when the caller passes no resolved token', async () => {
    const service = new PushNotaryService(mockRemoteBundleOps(), mockSftpService(), mockCleanPusher(), mockGitProvider(), mockHubRepoCache());
    const result = await service.notarize({
      taskId: 1, unitId: 1, server: makeServer() as any,
      transport: {} as any, worktreePath: '/wt', branch: 'feat', baseBranch: 'main', repo: makeRepo(), token: '',
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('push credential');
  });

  // The service pushes with the credential it was HANDED, never with
  // `repo.token` — that is what lets a repository with no PAT be pushed with
  // the hub's own `gh`/`glab` token (Issue #87).
  it('pushes with the caller-resolved token, not repo.token', async () => {
    const remoteBundleOps = mockRemoteBundleOps({ getHeadSha: vi.fn(async () => sha) });
    const gitProvider = { getBranchHeadSha: vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(sha),
    } as any;
    const cleanPusher = mockCleanPusher(sha);
    const service = new PushNotaryService(remoteBundleOps, mockSftpService(), cleanPusher, gitProvider, mockHubRepoCache());
    const result = await service.notarize({
      taskId: 1, unitId: 1, server: makeServer() as any,
      transport: {} as any, worktreePath: '/wt', branch: 'feat', baseBranch: 'main',
      repo: makeRepo({ token: null }), token: 'gh-cli-token',
    });
    expect(result.status).toBe('notarized');
    expect(cleanPusher.push).toHaveBeenCalledWith(expect.any(String), expect.anything(), 'gh-cli-token', 'feat', expect.anything());
  });

  it('returns already_up_to_date when remote matches worker HEAD', async () => {
    const remoteBundleOps = mockRemoteBundleOps({ getHeadSha: vi.fn(async () => sha) });
    const gitProvider = mockGitProvider(sha);
    const service = new PushNotaryService(remoteBundleOps, mockSftpService(), mockCleanPusher(), gitProvider, mockHubRepoCache());
    const result = await service.notarize({
      taskId: 1, unitId: 1, server: makeServer() as any,
      transport: {} as any, worktreePath: '/wt', branch: 'feat', baseBranch: 'main', repo: makeRepo(), token: 'ghp_test',
    });
    expect(result.status).toBe('already_up_to_date');
    expect(result.sha).toBe(sha);
  });

  it('notarizes successfully when push lands', async () => {
    const remoteBundleOps = mockRemoteBundleOps({ getHeadSha: vi.fn(async () => sha) });
    const gitProvider = { getBranchHeadSha: vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(sha),
    } as any;
    const cleanPusher = mockCleanPusher(sha);
    const sftpService = mockSftpService();
    const service = new PushNotaryService(remoteBundleOps, sftpService, cleanPusher, gitProvider, mockHubRepoCache());
    const result = await service.notarize({
      taskId: 1, unitId: 1, server: makeServer() as any,
      transport: {} as any, worktreePath: '/wt', branch: 'feat', baseBranch: 'main', repo: makeRepo(), token: 'ghp_test',
    });
    expect(result.status).toBe('notarized');
    expect(result.sha).toBe(sha);
    expect(sftpService.download).toHaveBeenCalled();
    expect(remoteBundleOps.cleanup).toHaveBeenCalled();
  });

  it('returns failed when push verification fails', async () => {
    const remoteBundleOps = mockRemoteBundleOps({ getHeadSha: vi.fn(async () => sha) });
    const differentSha = 'b'.repeat(40);
    const gitProvider = { getBranchHeadSha: vi.fn()
      .mockResolvedValueOnce(null)       // pre-push already_up_to_date check
      .mockResolvedValueOnce(differentSha)  // retry 1
      .mockResolvedValueOnce(differentSha)  // retry 2
      .mockResolvedValueOnce(differentSha), // retry 3
    } as any;
    const service = new PushNotaryService(remoteBundleOps, mockSftpService(), mockCleanPusher(sha), gitProvider, mockHubRepoCache());
    const result = await service.notarize({
      taskId: 1, unitId: 1, server: makeServer() as any,
      transport: {} as any, worktreePath: '/wt', branch: 'feat', baseBranch: 'main', repo: makeRepo(), token: 'ghp_test',
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('remote verification timed out');
  });

  it('retries verification and succeeds on second attempt (#124 Bug 4)', async () => {
    const remoteBundleOps = mockRemoteBundleOps({ getHeadSha: vi.fn(async () => sha) });
    const gitProvider = { getBranchHeadSha: vi.fn()
      .mockResolvedValueOnce(null)  // pre-push
      .mockResolvedValueOnce(null)  // retry 1: not yet reflected
      .mockResolvedValueOnce(sha),  // retry 2: reflected
    } as any;
    const service = new PushNotaryService(remoteBundleOps, mockSftpService(), mockCleanPusher(sha), gitProvider, mockHubRepoCache());
    const result = await service.notarize({
      taskId: 1, unitId: 1, server: makeServer() as any,
      transport: {} as any, worktreePath: '/wt', branch: 'feat', baseBranch: null, repo: makeRepo(), token: 'ghp_test',
    });
    expect(result.status).toBe('notarized');
    expect(gitProvider.getBranchHeadSha).toHaveBeenCalledTimes(3);
  });

  it('falls back to full bundle on prerequisite error (#124 Bug 1)', async () => {
    const remoteBundleOps = mockRemoteBundleOps({ getHeadSha: vi.fn(async () => sha) });
    const cleanPusher = {
      push: vi.fn()
        .mockImplementationOnce(() => { throw new Error('error: Repository lacks these prerequisite commits:'); })
        .mockReturnValueOnce({ pushedSha: sha }),
    } as any;
    const gitProvider = { getBranchHeadSha: vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(sha),
    } as any;
    const service = new PushNotaryService(remoteBundleOps, mockSftpService(), cleanPusher, gitProvider, mockHubRepoCache());
    const result = await service.notarize({
      taskId: 1, unitId: 1, server: makeServer() as any,
      transport: {} as any, worktreePath: '/wt', branch: 'feat', baseBranch: 'main', repo: makeRepo(), token: 'ghp_test',
    });
    expect(result.status).toBe('notarized');
    expect(remoteBundleOps.createFromWorktree).toHaveBeenCalledTimes(2);
    expect(remoteBundleOps.createFromWorktree).toHaveBeenLastCalledWith(expect.anything(), '/wt', 'feat', null);
  });

  it('does NOT fall back to full bundle on authentication errors (#124 Bug 1)', async () => {
    const remoteBundleOps = mockRemoteBundleOps({ getHeadSha: vi.fn(async () => sha) });
    const cleanPusher = {
      push: vi.fn(() => { throw new Error('fatal: Authentication failed for ...'); }),
    } as any;
    const gitProvider = { getBranchHeadSha: vi.fn().mockResolvedValueOnce(null) } as any;
    const service = new PushNotaryService(remoteBundleOps, mockSftpService(), cleanPusher, gitProvider, mockHubRepoCache());
    const result = await service.notarize({
      taskId: 1, unitId: 1, server: makeServer() as any,
      transport: {} as any, worktreePath: '/wt', branch: 'feat', baseBranch: 'main', repo: makeRepo(), token: 'ghp_test',
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Authentication failed');
    expect(remoteBundleOps.createFromWorktree).toHaveBeenCalledTimes(1);
  });

  it('returns failed when worker HEAD cannot be read', async () => {
    const remoteBundleOps = mockRemoteBundleOps({ getHeadSha: vi.fn(async () => null) });
    const service = new PushNotaryService(remoteBundleOps, mockSftpService(), mockCleanPusher(), mockGitProvider(), mockHubRepoCache());
    const result = await service.notarize({
      taskId: 1, unitId: 1, server: makeServer() as any,
      transport: {} as any, worktreePath: '/wt', branch: 'feat', baseBranch: 'main', repo: makeRepo(), token: 'ghp_test',
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('HEAD SHA');
  });
});
