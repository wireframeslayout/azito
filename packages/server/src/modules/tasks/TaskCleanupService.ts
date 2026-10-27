import { readdirSync, unlinkSync } from 'fs';
import * as path from 'path';
import type { Task } from './Task';
import type { IExecutionLogRepository } from './ExecutionLog';
import { TaskTempFiles } from '../../shared/os/taskTempFiles';
import { recordedTempFilePaths, recordedTempFilePathsOnHost } from './recordedTempFiles';
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
import { FileOpsError, type IFileOps } from '../../shared/fs/fileOps';
import { pathApiFor } from '../../shared/os/hostPath';
import type { IServerTransport } from '../servers/transport/ServerTransport';
import type { HostPlatform } from '../../shared/os/hostEnv';

/**
 * Whether `worktreePath` may be removed as the task's own worktree: it resolves, on the host, to `<repo>/.worktrees/task-<id>` of
 * the repository's resolved directory. A path that is already gone (`NOT_FOUND`) cannot be compared and is let through: removing
 * it only prunes git's registry, and nothing is deleted on the strength of how the path is spelled.
 */
async function mayRemoveWorktree(transport: IServerTransport, platform: HostPlatform, repoDir: string, worktreePath: string, taskId: number): Promise<boolean> {
  const api = hostPathFor(platform);
  const files = transport.files();
  try {
    const actual = await files.realpath(worktreePath);
    const expected = api.join(await files.realpath(repoDir), '.worktrees', `task-${taskId}`);
    return api.samePath(actual, expected);
  } catch (err) {
    if (err instanceof FileOpsError && err.code === 'NOT_FOUND') return true;
    throw err;
  }
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

/** The real path of an existing entry, or null when there is none. */
async function realpathIfExists(files: IFileOps, filePath: string): Promise<string | null> {
  try {
    return await files.realpath(filePath);
  } catch (e) {
    if (e instanceof FileOpsError && e.code === 'NOT_FOUND') return null;
    throw e;
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

  /**
   * The task's temp files on another host (an agent's): the paths recorded in its execution_log, removed through that host's own file
   * operations. The prompt file (#532) holds the task's text and is not left behind there. A recorded path is trusted only as far as
   * the hub wrote it: it has to be a file directly in the temp folder the agent reported (its real path, so a link in the parent is no
   * way out of it) and carry this task's file name, and it is removed with `unlink`, which refuses a directory and is never recursive.
   * A file that is already gone is fine.
   */
  private async removeHostTempFiles(task: Task, server: ServerConfig, log: { warn: (msg: string) => void }): Promise<void> {
    const files = this.deps.transportFactory.getTransport(server).files();
    const recorded = recordedTempFilePathsOnHost(this.deps.logRepo.findByTask(task.id), task.id, files.platform);
    if (recorded.length === 0) return;
    // Asking the agent for its temp folder needs the agent: one that is offline must not stop the task from being deleted or archived,
    // as the worktree's removal above does not. The files are left (and said so) in that case.
    let tempServer: Awaited<ReturnType<TransportFactory['taskTempServer']>>;
    let tempDir: string | null;
    try {
      tempServer = await this.deps.transportFactory.taskTempServer(server);
      if (tempServer.type !== 'agent') return;
      tempDir = await realpathIfExists(files, tempServer.tmpDir);
    } catch (e) {
      log.warn(`[task-cleanup] Not removing the temp files of task ${task.id} on ${server.name}: the temp folder could not be read (${(e as Error).message})`);
      return;
    }
    if (tempDir === null) return;
    const pathApi = pathApiFor(files.platform);
    const sameDirectory = (a: string, b: string): boolean => (files.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
    const namePattern = new RegExp(`^azito-(?:prompt|pipe|output|rules)-${task.id}-[A-Za-z0-9._-]+$`);
    for (const filePath of recorded) {
      try {
        const parent = await realpathIfExists(files, pathApi.dirname(filePath));
        if (!namePattern.test(pathApi.basename(filePath)) || parent === null || !sameDirectory(parent, tempDir)) {
          log.warn(`[task-cleanup] Not removing ${filePath} on ${server.name}: not a file of task ${task.id} directly in ${tempServer.tmpDir}`);
          continue;
        }
        await files.unlink(filePath);
      } catch (e) {
        if (e instanceof FileOpsError && e.code === 'NOT_FOUND') continue;
        log.warn(`[task-cleanup] Failed to remove temp file ${filePath} on ${server.name}: ${(e as Error).message}`);
      }
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
            if (!(await mayRemoveWorktree(transport, platform, repoDir, task.worktreePath, task.id))) {
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
    } else {
      await this.removeHostTempFiles(task, server, log);
    }
  }
}
