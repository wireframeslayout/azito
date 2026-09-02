import { describe, it, expect, vi } from 'vitest';
import { resolveTaskPromptVars } from './resolveTaskPromptVars';
import type { ITaskRepository } from '../tasks/Task';
import type { IProjectRepository } from '../projects/Project';
import type { IUnitRepository } from '../units/Unit';
import type { IProjectServerRepository } from '../projects/ProjectServer';

const makeTask = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  projectId: 10,
  unitId: 20,
  serverName: 'local',
  title: 'Test Task',
  description: 'A description',
  status: 'open' as const,
  currentPhase: null,
  selfReviewCount: 0,
  requirePlanApproval: false,
  worktreePath: null,
  worktreeBranch: null,
  baseBranch: null,
  targetBranch: null,
  skipPr: false,
  workingDirectory: null,
  branch: null,
  planMarkdown: null,
  ...overrides,
});

function makeDeps(overrides: {
  task?: Record<string, unknown>;
  projectRepositories?: Array<{ id: number; provider: string }>;
} = {}) {
  const taskRepo = { findById: vi.fn(() => makeTask(overrides.task)) } as unknown as ITaskRepository;
  const projectRepo = {
    findById: vi.fn(() => ({
      id: 10, sidekickPrompt: '', defaultBranch: 'main',
      repositories: overrides.projectRepositories ?? [
        { id: 1, name: 'A', url: 'https://github.com/acme/repo-a.git', provider: 'github', owner: 'acme', repoName: 'repo-a', hasToken: true },
      ],
    })),
  } as unknown as IProjectRepository;
  const unitRepo = { findById: vi.fn(() => null) } as unknown as IUnitRepository;
  const projectServerRepo = { find: vi.fn(() => null) } as unknown as IProjectServerRepository;
  return { taskRepo, projectRepo, unitRepo, projectServerRepo };
}

// Issue #87 14th-round review, Minor finding: AZITO_GIT_PROVIDER must
// reflect whichever repository the caller already resolved as THE
// repository for this run (e.g. a GitLab repo B chosen as the distribution
// target), not always `project.repositories[0]` — otherwise the pushing
// worker is told to use `gh` when the actual configured repository is on
// GitLab (`glab`).
describe('resolveTaskPromptVars gitProvider', () => {
  it('uses repositories[0]\'s provider when no resolvedGitProvider is passed (default, unchanged behavior)', () => {
    const { taskRepo, projectRepo, unitRepo, projectServerRepo } = makeDeps();
    const vars = resolveTaskPromptVars(taskRepo, projectRepo, unitRepo, projectServerRepo, 1);
    expect(vars.task.gitProvider).toBe('github');
  });

  it('uses the caller-supplied resolvedGitProvider (e.g. gitlab) when passed, overriding repositories[0]', () => {
    const { taskRepo, projectRepo, unitRepo, projectServerRepo } = makeDeps({
      projectRepositories: [
        { id: 1, name: 'A (repositories[0], github)', url: 'https://github.com/acme/repo-a.git', provider: 'github' as any, owner: 'acme', repoName: 'repo-a', hasToken: true } as any,
        { id: 2, name: 'B (distribution target, gitlab)', url: 'https://gitlab.com/acme/repo-b.git', provider: 'gitlab' as any, owner: 'acme', repoName: 'repo-b', hasToken: true } as any,
      ],
    });
    const vars = resolveTaskPromptVars(taskRepo, projectRepo, unitRepo, projectServerRepo, 1, 'gitlab');
    expect(vars.task.gitProvider).toBe('gitlab');
  });

  it('falls back to the "github" default when the project has no repositories at all and no resolvedGitProvider is passed', () => {
    const { taskRepo, projectRepo, unitRepo, projectServerRepo } = makeDeps({ projectRepositories: [] });
    const vars = resolveTaskPromptVars(taskRepo, projectRepo, unitRepo, projectServerRepo, 1);
    expect(vars.task.gitProvider).toBe('github');
  });
});
