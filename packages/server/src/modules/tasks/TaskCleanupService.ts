import { readdirSync, unlinkSync } from 'fs';
import type { Task } from './Task';
import type { IServerRepository } from '../servers/Server';
import type { TmuxClient } from '../tmux/TmuxClient';
import type { WorktreeServiceFactory } from '../git/WorktreeServiceFactory';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { IProjectServerRepository } from '../projects/ProjectServer';
import type { IProjectRepository } from '../projects/Project';
import { resolveTaskServerName, resolveTmuxSession } from './execution/TaskExecutionEnv';

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
  tmux: TmuxClient;
  worktreeServiceFactory: WorktreeServiceFactory;
  transportFactory: TransportFactory;
  projectServerRepo: IProjectServerRepository;
  projectRepo: IProjectRepository;
}

export class TaskCleanupService {
  constructor(private deps: TaskCleanupDeps) {}

  async cleanup(task: Task, log: { warn: (msg: string) => void }): Promise<void> {
    const { serverRepo, tmux, worktreeServiceFactory, transportFactory, projectServerRepo, projectRepo } = this.deps;

    const resolvedServerName = resolveTaskServerName(task, projectServerRepo);
    const server = resolvedServerName ? serverRepo.findByName(resolvedServerName) : null;

    if (task.tmuxWindow && resolvedServerName && server) {
      const tmuxSession = resolveTmuxSession(task.projectId, resolvedServerName, projectServerRepo);
      const target = `${tmuxSession}:${task.tmuxWindow}`;
      tmux.killWindow(server, target).catch((e) => {
        log.warn(`[task-cleanup] Failed to kill tmux window ${target}: ${(e as Error).message}`);
      });
    }

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
