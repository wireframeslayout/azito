import { readdirSync, unlinkSync } from 'fs';
import * as path from 'path';
import type { Task } from './Task';
import type { IExecutionLogRepository } from './ExecutionLog';
import { TaskTempFiles } from '../../shared/os/taskTempFiles';
import { recordedTempFilePaths } from './recordedTempFiles';
import type { IServerRepository, ServerConfig } from '../servers/Server';
import type { MuxDriverRegistry } from '../tmux/MuxDriverRegistry';
import type { WorktreeServiceFactory } from '../git/WorktreeServiceFactory';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { IProjectServerRepository } from '../projects/ProjectServer';
import type { IProjectRepository } from '../projects/Project';
import { resolveTaskServerName, resolveMuxWorkspace } from './execution/TaskExecutionEnv';
import { isPrimaryTaskWindow, type IWindowRepository } from '../windows/Window';
import { MuxDriverUnavailableError } from '../tmux/MuxCapabilityError';
import { resolveKillOutcome } from '../tmux/killOutcome';
import { muxWindowTarget } from '../tmux/muxWindowTarget';
import { taskWindowRef } from '../tmux/windowIdentity';
import { resolveStoredWindowKind } from '../tmux/storedWindowKind';
import { taskIdOfWorktreePath } from '../git/gitPath';
import { platformOfProfile } from '../../shared/os/hostProfile';
import { hostPathFor } from '@azito/shared';
import { resolveGitPath } from '../git/gitPath';
import type { IServerTransport } from '../servers/transport/ServerTransport';
import type { HostPlatform } from '../../shared/os/hostEnv';

/**
 * Whether `worktreePath` is the task's own worktree directly under the repository's `.worktrees`, judged on the host's resolved
 * paths (a `~` or a symbolic link in either spelling must not make another directory pass). A worktree below the repository as
 * written keeps that prefix as resolved, so a directory that is already gone can still be recognised.
 */
async function isWorktreeOfRepo(transport: IServerTransport, platform: HostPlatform, repoDir: string, worktreePath: string, taskId: number): Promise<boolean> {
  const api = hostPathFor(platform);
  const realRepo = await transport.files().realpath(repoDir);
  const relative = api.relative(repoDir, worktreePath);
  const isBelow = relative !== '' && relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative);
  const actual = isBelow ? api.join(realRepo, relative) : await resolveGitPath(transport, worktreePath);
  return api.samePath(actual, api.join(realRepo, '.worktrees', `task-${taskId}`));
}

/**
 * Removes the task's temp files of the hub's own server: the paths recorded in its execution_log first, then whatever
 * carries the task's file-name prefixes in the folders the hub places them in (the current one, plus the legacy `/tmp`
 * on Unix — see TaskTempFiles.hubScanDirs).
 */
function removeTempFiles(taskId: number, taskTempFiles: TaskTempFiles, recorded: readonly string[], log: { warn: (msg: string) => void }): void {
  const remove = (filePath: string): void => {
    try { unlinkSync(filePath); } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      log.warn(`[task-cleanup] Failed to remove temp file ${filePath}: ${(e as Error).message}`);
    }
  };
  recorded.forEach(remove);
  const prefixes = TaskTempFiles.prefixesForTask(taskId);
  for (const dir of taskTempFiles.hubScanDirs()) {
    try {
      for (const f of readdirSync(dir)) {
        if (prefixes.some(p => f.startsWith(p))) remove(path.join(dir, f));
      }
    } catch (e) {
      log.warn(`[task-cleanup] Failed to read ${dir} for cleanup: ${(e as Error).message}`);
    }
  }
}

export interface TaskCleanupDeps {
  serverRepo: IServerRepository;
  worktreeServiceFactory: WorktreeServiceFactory;
  transportFactory: TransportFactory;
  projectServerRepo: IProjectServerRepository;
  projectRepo: IProjectRepository;
  muxDriverRegistry: MuxDriverRegistry;
  windowRepo: IWindowRepository;
  logRepo: IExecutionLogRepository;
  taskTempFiles: TaskTempFiles;
}

export class TaskCleanupService {
  constructor(private deps: TaskCleanupDeps) {}

  /**
   * First step of deleting / archiving a task, before anything is changed (approval consumption, stopping
   * the execution, closing the window, deleting rows): throws MuxDriverUnavailableError (503) when the mux
   * driver of the task's window is not usable, so the request can be refused with nothing changed — deleting
   * the task and its window rows would otherwise orphan a misao window with no identity left to remove it by.
   */
  assertWindowCloseable(task: Task): void {
    const { serverRepo, projectServerRepo } = this.deps;
    const serverName = resolveTaskServerName(task, projectServerRepo);
    const server = serverName ? serverRepo.findByName(serverName) : null;
    if (!task.tmuxWindow || !server) return;
    this.deps.muxDriverRegistry.resolve(server);
  }

  /**
   * Closes the task's window by its identity — the primary window row's mux_ref for misao, otherwise
   * task.tmuxWindow. Run after the approval was handled and the execution stopped, so nothing keeps using the
   * window while it closes, and an approval conflict (409) leaves the window alone.
   * A window that could not be confirmed closed is a warning; the caller carries on.
   * A connection that drops DURING the close throws MuxDriverUnavailableError (503) with the execution already
   * stopped and the task and its rows kept — accepted: the request can simply be retried. A connection loss the
   * driver reports only as a failed result (not as an error) cannot be told apart from another failure and is
   * a warning.
   */
  async closeWindow(task: Task, log: { warn: (msg: string) => void }): Promise<void> {
    const { serverRepo, projectServerRepo, windowRepo } = this.deps;
    const serverName = resolveTaskServerName(task, projectServerRepo);
    const server = serverName ? serverRepo.findByName(serverName) : null;
    if (!task.tmuxWindow || !serverName || !server) return;

    const driver = this.deps.muxDriverRegistry.resolve(server);
    const muxWorkspace = resolveMuxWorkspace(task.projectId, serverName, projectServerRepo);
    const primaryWin = windowRepo.findByTask(task.id).find((w) => isPrimaryTaskWindow(w));
    const ref = taskWindowRef(task, primaryWin, muxWorkspace, await resolveStoredWindowKind(this.deps.muxDriverRegistry, server, primaryWin, muxWorkspace, task.tmuxWindow));
    if (!ref) return;
    const closing = driver.closeWindow(server, ref);
    try {
      await closing;
    } catch (err) {
      if (err instanceof MuxDriverUnavailableError) throw err;
    }
    const outcome = await resolveKillOutcome(closing);
    if (!outcome.success) {
      log.warn(`[task-cleanup] Failed to close window ${muxWindowTarget(ref)} of task ${task.id}: ${outcome.result.stderr || outcome.result.stdout}`);
    }
  }

  async cleanup(task: Task, log: { warn: (msg: string) => void }): Promise<void> {
    const { serverRepo, worktreeServiceFactory, transportFactory, projectServerRepo, projectRepo } = this.deps;

    const resolvedServerName = resolveTaskServerName(task, projectServerRepo);
    const server = resolvedServerName ? serverRepo.findByName(resolvedServerName) : null;

    if (!server || !resolvedServerName) return;

    if (task.worktreePath) {
      const platform = platformOfProfile(transportFactory.hostProfileFor(server));
      if (taskIdOfWorktreePath(platform, task.worktreePath) !== task.id) {
        log.warn(`[task-cleanup] Skipping worktree removal: not the worktree path of task ${task.id} (<repo>/.worktrees/task-${task.id}): ${task.worktreePath}`);
      } else {
        const project = projectRepo.findById(task.projectId);
        const projectServer = project
          ? projectServerRepo.find(task.projectId, resolvedServerName)
          : null;
        const repoDir = task.workingDirectory || projectServer?.workingDirectory;
        if (repoDir) {
          try {
            const transport = transportFactory.getTransport(server);
            if (!(await isWorktreeOfRepo(transport, platform, repoDir, task.worktreePath, task.id))) {
              log.warn(`[task-cleanup] Skipping worktree removal: ${task.worktreePath} is not under ${repoDir}/.worktrees`);
            } else {
              await worktreeServiceFactory.create(transport).remove(repoDir, task.worktreePath);
            }
          } catch (e) {
            log.warn(`[task-cleanup] Failed to remove worktree ${task.worktreePath}: ${(e as Error).message}`);
          }
        }
      }
    }

    if (server.type === 'local') {
      removeTempFiles(task.id, this.deps.taskTempFiles, recordedTempFilePaths(this.deps.logRepo.findByTask(task.id), task.id), log);
    }
  }
}
