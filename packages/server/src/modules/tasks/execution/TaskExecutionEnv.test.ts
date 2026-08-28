import { describe, it, expect, vi } from 'vitest';
import { resolveTaskServerName, resolveTmuxSession, resolveUnitId, resolveWorktreeCreateBaseBranch } from './TaskExecutionEnv';
import type { IProjectServerRepository } from '../../projects/ProjectServer';
import type { ProjectDetail } from '../../projects/Project';

function makeProjectServerRepo(overrides: Partial<IProjectServerRepository> = {}): IProjectServerRepository {
  return {
    findByProject: vi.fn(() => []),
    findByServer: vi.fn(() => []),
    find: vi.fn(() => null),
    upsert: vi.fn(),
    remove: vi.fn(),
    ...overrides,
  };
}

describe('resolveTaskServerName', () => {
  it('returns the task serverName override when present', () => {
    const repo = makeProjectServerRepo({ findByProject: vi.fn(() => []) });
    const result = resolveTaskServerName({ projectId: 1, serverName: 'server-a' }, repo);
    expect(result).toBe('server-a');
  });

  it('falls back to the project server when task.serverName is null and exactly one exists', () => {
    const repo = makeProjectServerRepo({
      findByProject: vi.fn(() => [
        { projectId: 1, serverName: 'server-b', workingDirectory: null, branch: null, tmuxSession: 'azito', inputPolicy: 'manual-approval' as const, distributeCode: false },
      ]),
    });
    const result = resolveTaskServerName({ projectId: 1, serverName: null }, repo);
    expect(result).toBe('server-b');
  });

  it('returns null when task.serverName is null and the project has no project_servers rows', () => {
    const repo = makeProjectServerRepo({ findByProject: vi.fn(() => []) });
    const result = resolveTaskServerName({ projectId: 1, serverName: null }, repo);
    expect(result).toBeNull();
  });

  it('returns null (ambiguous) when task.serverName is null and the project has multiple project_servers rows', () => {
    const repo = makeProjectServerRepo({
      findByProject: vi.fn(() => [
        { projectId: 1, serverName: 'server-b', workingDirectory: null, branch: null, tmuxSession: 'azito', inputPolicy: 'manual-approval' as const, distributeCode: false },
        { projectId: 1, serverName: 'server-c', workingDirectory: null, branch: null, tmuxSession: 'azito', inputPolicy: 'manual-approval' as const, distributeCode: false },
      ]),
    });
    const result = resolveTaskServerName({ projectId: 1, serverName: null }, repo);
    expect(result).toBeNull();
  });
});

describe('resolveTmuxSession', () => {
  it('returns the project_servers tmux_session when a row exists', () => {
    const repo = makeProjectServerRepo({
      find: vi.fn(() => ({ projectId: 1, serverName: 'server-a', workingDirectory: null, branch: null, tmuxSession: 'custom-session', inputPolicy: 'manual-approval' as const, distributeCode: false })),
    });
    expect(resolveTmuxSession(1, 'server-a', repo)).toBe('custom-session');
  });

  it('falls back to "azito" when no project_servers row links this project/server', () => {
    const repo = makeProjectServerRepo({ find: vi.fn(() => null) });
    expect(resolveTmuxSession(1, 'server-a', repo)).toBe('azito');
  });
});

describe('resolveUnitId', () => {
  it('returns the task unitId override when present', () => {
    const project: Pick<ProjectDetail, 'defaultUnitId'> = { defaultUnitId: 99 };
    expect(resolveUnitId({ unitId: 5 }, project)).toBe(5);
  });

  it('falls back to project.defaultUnitId when task has no override', () => {
    const project: Pick<ProjectDetail, 'defaultUnitId'> = { defaultUnitId: 99 };
    expect(resolveUnitId({ unitId: null }, project)).toBe(99);
  });

  it('returns null when both task override and project default are missing', () => {
    const project: Pick<ProjectDetail, 'defaultUnitId'> = { defaultUnitId: null };
    expect(resolveUnitId({ unitId: null }, project)).toBeNull();
  });

  it('returns null when project is null and task has no override', () => {
    expect(resolveUnitId({ unitId: null }, null)).toBeNull();
  });
});

describe('resolveWorktreeCreateBaseBranch', () => {
  // Issue #87 review, forge/87-mirror follow-up: fetch distribution only
  // ever updates `refs/remotes/origin/<branch>` on the remote workingDir,
  // never the local branch ref, so worktree creation must resolve
  // `origin/<baseBranch>` whenever distribution landed content this call.

  it('returns origin/<branch> when distribution succeeded with new content', () => {
    expect(resolveWorktreeCreateBaseBranch('main', 'distributed')).toBe('origin/main');
  });

  it('returns origin/<branch> when distribution found the mirror already current', () => {
    expect(resolveWorktreeCreateBaseBranch('main', 'already_current')).toBe('origin/main');
  });

  it('returns the plain branch when distribution did not run this call (local/ssh servers)', () => {
    expect(resolveWorktreeCreateBaseBranch('main', null)).toBe('main');
  });

  it('does not get called with a failed distStatus (execute() throws before reaching worktree creation), but returns the plain branch defensively', () => {
    expect(resolveWorktreeCreateBaseBranch('main', 'failed')).toBe('main');
  });

  // Issue #87 third-party review, 10th round, Important finding 1: a
  // pre-existing task saved with an already `origin/`-qualified baseBranch
  // must not be double-prefixed into the nonexistent `origin/origin/main`.
  it('does not double-prefix an already origin/-qualified baseBranch when distribution succeeded', () => {
    expect(resolveWorktreeCreateBaseBranch('origin/main', 'distributed')).toBe('origin/main');
  });

  it('does not double-prefix an already origin/-qualified baseBranch when the mirror was already current', () => {
    expect(resolveWorktreeCreateBaseBranch('origin/main', 'already_current')).toBe('origin/main');
  });

  it('leaves an origin/-qualified baseBranch untouched when distribution did not run', () => {
    expect(resolveWorktreeCreateBaseBranch('origin/main', null)).toBe('origin/main');
  });
});
