import { readdirSync, unlinkSync } from 'fs';
import type { Task } from './Task';
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

const WORKTREE_PATH_PATTERN = /^[a-zA-Z0-9_./@:~-]+\/\.worktrees\/task-\d+$/;

function removeTempFiles(taskId: number, log: { warn: (msg: string) => void }): void {
  const prefixes = [`azito-pipe-${taskId}-`, `azito-output-${taskId}-`, `azito-rules-${taskId}-`];
  try {
    for (const f of readdirSync('/tmp')) {
      if (prefixes.some(p => f.startsWith(p))) {
        try { unlinkSync(`/tmp/${f}`); } catch (e) {
          log.warn(`[task-cleanup] Failed to remove temp file /tmp/${f}: ${(e as Error).message}`);
        }
      }
    }
  } catch (e) {
    log.warn(`[task-cleanup] Failed to read /tmp for cleanup: ${(e as Error).message}`);
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
    const ref = taskWindowRef(task, primaryWin, muxWorkspace, driver.kind);
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
      if (!WORKTREE_PATH_PATTERN.test(task.worktreePath)) {
        log.warn(`[task-cleanup] Skipping worktree removal: path does not match expected pattern: ${task.worktreePath}`);
      } else {
        const project = projectRepo.findById(task.projectId);
        const projectServer = project
          ? projectServerRepo.find(task.projectId, resolvedServerName)
          : null;
        const repoDir = task.workingDirectory || projectServer?.workingDirectory;
        if (repoDir) {
          try {
            const transport = transportFactory.getTransport(server);
            const worktreeService = worktreeServiceFactory.create(server.type, transport);
            await worktreeService.remove(repoDir, task.worktreePath);
          } catch (e) {
            log.warn(`[task-cleanup] Failed to remove worktree ${task.worktreePath}: ${(e as Error).message}`);
          }
        }
      }
    }

    if (server.type === 'local') {
      removeTempFiles(task.id, log);
    }
  }
}
