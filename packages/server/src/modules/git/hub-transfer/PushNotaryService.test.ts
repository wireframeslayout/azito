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
    const service = new PushNotaryService(mockRemoteBundleOps(), mockSftpService(), mockCleanPusher(), mockGitProvider());
    const result = await service.notarize({
      taskId: 1, unitId: 1, server: makeServer({ sshHost: null }) as any,
      transport: {} as any, worktreePath: '/wt', branch: 'feat', baseBranch: 'main', repo: makeRepo(),
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('sshHost');
  });

  it('returns failed when token is missing', async () => {
    const service = new PushNotaryService(mockRemoteBundleOps(), mockSftpService(), mockCleanPusher(), mockGitProvider());
    const result = await service.notarize({
      taskId: 1, unitId: 1, server: makeServer() as any,
      transport: {} as any, worktreePath: '/wt', branch: 'feat', baseBranch: 'main', repo: makeRepo({ token: null }),
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('push credential');
  });

  it('returns already_up_to_date when remote matches worker HEAD', async () => {
    const remoteBundleOps = mockRemoteBundleOps({ getHeadSha: vi.fn(async () => sha) });
    const gitProvider = mockGitProvider(sha);
    const service = new PushNotaryService(remoteBundleOps, mockSftpService(), mockCleanPusher(), gitProvider);
    const result = await service.notarize({
      taskId: 1, unitId: 1, server: makeServer() as any,
      transport: {} as any, worktreePath: '/wt', branch: 'feat', baseBranch: 'main', repo: makeRepo(),
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
    const service = new PushNotaryService(remoteBundleOps, sftpService, cleanPusher, gitProvider);
    const result = await service.notarize({
      taskId: 1, unitId: 1, server: makeServer() as any,
      transport: {} as any, worktreePath: '/wt', branch: 'feat', baseBranch: 'main', repo: makeRepo(),
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
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(differentSha),
    } as any;
    const service = new PushNotaryService(remoteBundleOps, mockSftpService(), mockCleanPusher(sha), gitProvider);
    const result = await service.notarize({
      taskId: 1, unitId: 1, server: makeServer() as any,
      transport: {} as any, worktreePath: '/wt', branch: 'feat', baseBranch: 'main', repo: makeRepo(),
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Push verification failed');
  });

  it('returns failed when worker HEAD cannot be read', async () => {
    const remoteBundleOps = mockRemoteBundleOps({ getHeadSha: vi.fn(async () => null) });
    const service = new PushNotaryService(remoteBundleOps, mockSftpService(), mockCleanPusher(), mockGitProvider());
    const result = await service.notarize({
      taskId: 1, unitId: 1, server: makeServer() as any,
      transport: {} as any, worktreePath: '/wt', branch: 'feat', baseBranch: 'main', repo: makeRepo(),
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('HEAD SHA');
  });
});
