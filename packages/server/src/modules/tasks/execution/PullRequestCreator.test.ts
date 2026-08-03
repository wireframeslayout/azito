import { describe, it, expect, vi } from 'vitest';
import { PullRequestCreator } from './PullRequestCreator';
import type { ProjectRepositoryWithToken } from '../../projects/Project';

function makeRepo(overrides: Partial<ProjectRepositoryWithToken> = {}): ProjectRepositoryWithToken {
  return {
    id: 1,
    name: 'repo',
    url: 'https://github.com/acme/widgets',
    provider: 'github',
    owner: 'acme',
    repoName: 'widgets',
    token: null,
    ...overrides,
  };
}

function makeCreator(overrides: { findPullRequestByBranch?: ReturnType<typeof vi.fn>; createPullRequest?: ReturnType<typeof vi.fn> } = {}) {
  const taskRepo = { update: vi.fn() };
  const gitProvider = {
    findPullRequestByBranch: overrides.findPullRequestByBranch ?? vi.fn(async () => null),
    createPullRequest: overrides.createPullRequest ?? vi.fn(async () => ({ htmlUrl: 'https://github.com/acme/widgets/pull/1' })),
  };
  const appendLog = vi.fn();
  const creator = new PullRequestCreator(taskRepo as any, gitProvider as any, appendLog as any);
  return { creator, taskRepo, gitProvider, appendLog };
}

describe('PullRequestCreator (git provider abstraction Phase 4-A)', () => {
  it('creates a PR and stores prUrl when the branch is pushed and no PR exists yet', async () => {
    const { creator, taskRepo, gitProvider, appendLog } = makeCreator();

    await creator.ensureCreated(1, 2, makeRepo(), 'task/1-slug', {
      title: 'Add feature',
      description: 'A'.repeat(600),
      targetBranch: null,
    });

    expect(gitProvider.findPullRequestByBranch).toHaveBeenCalledWith(makeRepo(), 'task/1-slug');
    expect(gitProvider.createPullRequest).toHaveBeenCalledWith(makeRepo(), expect.objectContaining({
      head: 'task/1-slug',
      base: undefined,
      title: 'Add feature',
    }));
    // Body is capped to a ~500-char excerpt of the description, not the raw 600-char string.
    const body = (gitProvider.createPullRequest as any).mock.calls[0][1].body as string;
    expect(body.length).toBeLessThan(600);
    expect(taskRepo.update).toHaveBeenCalledWith(1, { prUrl: 'https://github.com/acme/widgets/pull/1' });
    expect(appendLog).toHaveBeenCalledWith(1, 2, 'command', { type: 'pr_auto_created', prUrl: 'https://github.com/acme/widgets/pull/1' });
  });

  it('does not create a PR when one already exists for the branch', async () => {
    const findPullRequestByBranch = vi.fn(async () => ({ htmlUrl: 'https://github.com/acme/widgets/pull/9' }));
    const createPullRequest = vi.fn();
    const { creator, taskRepo } = makeCreator({ findPullRequestByBranch, createPullRequest } as any);

    await creator.ensureCreated(1, 2, makeRepo(), 'task/1-slug', { title: 'x', description: null, targetBranch: null });

    expect(createPullRequest).not.toHaveBeenCalled();
    expect(taskRepo.update).not.toHaveBeenCalled();
  });

  it('skips silently when the project has no repository configured', async () => {
    const { creator, gitProvider } = makeCreator();

    await creator.ensureCreated(1, 2, null, 'task/1-slug', { title: 'x', description: null, targetBranch: null });

    expect(gitProvider.findPullRequestByBranch).not.toHaveBeenCalled();
    expect(gitProvider.createPullRequest).not.toHaveBeenCalled();
  });

  it('logs and swallows a creation failure instead of throwing (push completion never depends on PR creation)', async () => {
    const createPullRequest = vi.fn(async () => { throw new Error('403 Forbidden'); });
    const { creator, taskRepo, appendLog } = makeCreator({ createPullRequest } as any);

    await expect(
      creator.ensureCreated(1, 2, makeRepo(), 'task/1-slug', { title: 'x', description: null, targetBranch: null }),
    ).resolves.toBeUndefined();

    expect(taskRepo.update).not.toHaveBeenCalled();
    expect(appendLog).toHaveBeenCalledWith(1, 2, 'command', { type: 'pr_auto_create_failed', message: '403 Forbidden' });
  });

  it('passes task.targetBranch through as the PR base when set', async () => {
    const { creator, gitProvider } = makeCreator();

    await creator.ensureCreated(1, 2, makeRepo(), 'task/1-slug', { title: 'x', description: null, targetBranch: 'release/2.0' });

    expect(gitProvider.createPullRequest).toHaveBeenCalledWith(makeRepo(), expect.objectContaining({ base: 'release/2.0' }));
  });
});
