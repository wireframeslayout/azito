import { describe, it, expect, vi } from 'vitest';
import { TaskCleanupService, type TaskCleanupDeps } from './TaskCleanupService';
import type { Task } from './Task';
import type { HostProfile } from '../../shared/os/hostProfile';

function setup(hostProfile: HostProfile | null) {
  const remove = vi.fn(async () => {});
  const warn = vi.fn();
  const deps = {
    serverRepo: { findByName: () => ({ name: 's', type: 'agent', hostProfile }) },
    worktreeServiceFactory: { create: vi.fn(() => ({ remove })) },
    transportFactory: { getTransport: () => ({}), hostProfileFor: () => hostProfile },
    projectServerRepo: { find: () => ({ workingDirectory: '/repo' }), findByProject: () => [] },
    projectRepo: { findById: () => ({ id: 1 }) },
    muxDriverRegistry: {},
    windowRepo: { findByTaskId: () => [], findByTaskIds: () => new Map() },
    logRepo: { findByTask: () => [] },
    taskTempFiles: {},
  } as unknown as TaskCleanupDeps;
  const task = (worktreePath: string): Task => ({ id: 3, projectId: 1, serverName: 's', worktreePath, workingDirectory: '/repo' } as unknown as Task);
  return { service: new TaskCleanupService(deps), remove, warn, task };
}

const linux: HostProfile = { platform: 'linux', arch: 'x64' };
const win32: HostProfile = { platform: 'win32', arch: 'x64' };

describe('TaskCleanupService worktree removal', () => {
  it.each([
    '/home/user/project/.worktrees/task-1',
    '~/workspace/repo/.worktrees/task-42',
    '/home/user/my project/日本語/.worktrees/task-7',
  ])('removes %s on a POSIX host', async (worktreePath) => {
    const { service, remove, warn, task } = setup(linux);
    await service.cleanup(task(worktreePath), { warn });
    expect(remove).toHaveBeenCalledWith('/repo', worktreePath);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    'C:\\Users\\me\\My Repo\\.worktrees\\task-3',
    'C:/Users/me/repo/.worktrees/task-3',
    '~\\repo\\.worktrees\\task-3',
  ])('removes %s on a Windows host (not skipped by a POSIX-shaped pattern)', async (worktreePath) => {
    const { service, remove, warn, task } = setup(win32);
    await service.cleanup(task(worktreePath), { warn });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    '/home/user/.worktrees/notask',
    '/home/user/project/task-1',
    '/home/user/.worktrees/sub/task-1',
    '/home/user/project/.worktrees/task-1/extra',
  ])('skips %s: not a task worktree path', async (worktreePath) => {
    const { service, remove, warn, task } = setup(linux);
    await service.cleanup(task(worktreePath), { warn });
    expect(remove).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not a task worktree path'));
  });

  it('judges a Windows-spelled path by the host OS: it is not a worktree path on a POSIX host', async () => {
    const { service, remove, warn, task } = setup(linux);
    await service.cleanup(task('C:\\repo\\.worktrees\\task-3'), { warn });
    expect(remove).not.toHaveBeenCalled();
  });
});
