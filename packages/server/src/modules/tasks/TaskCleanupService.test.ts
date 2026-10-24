import { describe, it, expect, vi } from 'vitest';
import { TaskCleanupService, type TaskCleanupDeps } from './TaskCleanupService';
import type { Task } from './Task';
import type { HostProfile } from '../../shared/os/hostProfile';

const HOME = { linux: '/home/u', win32: 'C:\\Users\\me' } as const;

function setup(hostProfile: HostProfile | null, repoDir: string) {
  const remove = vi.fn(async () => {});
  const warn = vi.fn();
  const platform = hostProfile?.platform === 'win32' ? 'win32' : 'linux';
  const files = {
    platform,
    realpath: async (p: string) => (p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? `${HOME[platform]}${platform === 'win32' ? p.slice(1).replace(/\//g, '\\') : p.slice(1)}` : p),
  };
  const deps = {
    serverRepo: { findByName: () => ({ name: 's', type: 'agent', hostProfile }) },
    worktreeServiceFactory: { create: vi.fn(() => ({ remove })) },
    transportFactory: { getTransport: () => ({ files: () => files }), hostProfileFor: () => hostProfile },
    projectServerRepo: { find: () => ({ workingDirectory: repoDir }), findByProject: () => [] },
    projectRepo: { findById: () => ({ id: 1 }) },
    muxDriverRegistry: {},
    windowRepo: { findByTaskId: () => [], findByTaskIds: () => new Map() },
    logRepo: { findByTask: () => [] },
    taskTempFiles: {},
  } as unknown as TaskCleanupDeps;
  const task = (worktreePath: string): Task => ({ id: 3, projectId: 1, serverName: 's', worktreePath } as unknown as Task);
  return { service: new TaskCleanupService(deps), remove, warn, task };
}

const linux: HostProfile = { platform: 'linux', arch: 'x64' };
const win32: HostProfile = { platform: 'win32', arch: 'x64' };

describe('TaskCleanupService worktree removal', () => {
  it.each([
    ['/home/user/project', '/home/user/project/.worktrees/task-3'],
    ['~/workspace/repo', '~/workspace/repo/.worktrees/task-3'],
    ['/home/user/my project/日本語', '/home/user/my project/日本語/.worktrees/task-3'],
    ['~/repo', '/home/u/repo/.worktrees/task-3'],
  ])('removes the task worktree %s -> %s on a POSIX host', async (repoDir, worktreePath) => {
    const { service, remove, warn, task } = setup(linux, repoDir);
    await service.cleanup(task(worktreePath), { warn });
    expect(remove).toHaveBeenCalledWith(repoDir, worktreePath);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ['C:\\Users\\me\\My Repo', 'C:\\Users\\me\\My Repo\\.worktrees\\task-3'],
    ['C:/Users/me/repo', 'C:/Users/me/repo/.worktrees/task-3'],
    ['~\\repo', '~\\repo\\.worktrees\\task-3'],
  ])('removes the task worktree %s -> %s on a Windows host (not skipped by a POSIX-shaped pattern)', async (repoDir, worktreePath) => {
    const { service, remove, warn, task } = setup(win32, repoDir);
    await service.cleanup(task(worktreePath), { warn });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    '/home/user/.worktrees/notask',
    '/home/user/project/task-3',
    '/home/user/.worktrees/sub/task-3',
    '/home/user/project/.worktrees/task-3/extra',
    '/home/user/project/.worktrees/task-4',
  ])('skips %s: not the worktree path of this task', async (worktreePath) => {
    const { service, remove, warn, task } = setup(linux, '/home/user/project');
    await service.cleanup(task(worktreePath), { warn });
    expect(remove).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not the worktree path of task 3'));
  });

  it('skips a worktree path of this task that belongs to another repository', async () => {
    const { service, remove, warn, task } = setup(linux, '/home/user/project');
    await service.cleanup(task('/home/user/other/.worktrees/task-3'), { warn });
    expect(remove).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('is not under /home/user/project/.worktrees'));
  });

  it('judges a Windows-spelled path by the host OS: it is not a worktree path on a POSIX host', async () => {
    const { service, remove, task } = setup(linux, '/repo');
    await service.cleanup(task('C:\\repo\\.worktrees\\task-3'), { warn: vi.fn() });
    expect(remove).not.toHaveBeenCalled();
  });
});
