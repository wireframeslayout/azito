import type { ITaskRepository, Task } from '../Task';
import type { ProjectRepositoryWithToken as ProjectRepository } from '../../projects/Project';
import type { GitProviderService } from '../../git/providers/GitProviderService';
import type { AppendLogFn } from './WorkerWaiter';

/** Minimal task fields needed to build a PR title/body/base. */
export interface PullRequestSourceTask {
  title: string;
  description: string | null;
  targetBranch: string | null;
}

/**
 * Server-side PR/MR creation for the pushing phase (Issue: git provider
 * abstraction Phase 4-A — moved off the worker's push.sh so remote workers no
 * longer need a gh/glab CLI dependency).
 *
 * Idempotent by construction: always checks findPullRequestByBranch first and
 * only creates when nothing exists, so a repeated call (the pushing
 * completion probe polls on an idle timeout) never double-creates.
 * Best-effort: a create failure (permissions, provider outage, missing repo
 * config) is logged and swallowed — push completion never depends on PR
 * creation succeeding.
 */
export class PullRequestCreator {
  constructor(
    private taskRepo: ITaskRepository,
    private gitProvider: GitProviderService,
    private appendLog: AppendLogFn,
  ) {}

  async ensureCreated(
    taskId: number,
    unitId: number,
    repo: ProjectRepository | null,
    branch: string,
    task: PullRequestSourceTask,
  ): Promise<void> {
    if (!repo || !repo.owner || !repo.repoName) return;
    try {
      const existing = await this.gitProvider.findPullRequestByBranch(repo, branch);
      if (existing) return;

      const descriptionExcerpt = task.description ? task.description.slice(0, 500) : '';
      const body = [descriptionExcerpt, '----', `AZITO Task #${taskId}`].filter(Boolean).join('\n\n');
      const pr = await this.gitProvider.createPullRequest(repo, {
        head: branch,
        base: task.targetBranch ?? undefined,
        title: task.title,
        body,
      });
      this.taskRepo.update(taskId, { prUrl: pr.htmlUrl } as Partial<Task>);
      this.appendLog(taskId, unitId, 'command', { type: 'pr_auto_created', prUrl: pr.htmlUrl });
    } catch (err) {
      this.appendLog(taskId, unitId, 'command', {
        type: 'pr_auto_create_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
