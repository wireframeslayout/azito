import type { ITaskRepository } from '../tasks/Task';
import type { IProjectRepository } from '../projects/Project';
import type { IUnitRepository } from '../units/Unit';
import type { IProjectServerRepository } from '../projects/ProjectServer';
import type { TaskPromptVars } from '../sidekicks/ITaskPromptVarsResolver';
import { loadPromptModules } from './PromptModuleLoader';
import { resolveTaskServerName } from '../tasks/execution/TaskExecutionEnv';

/**
 * Builds the task/project/unit prompt-template vars for a given task.
 * Single source shared by RenderSkillPromptUseCase (phase-prompt skill render),
 * TaskPromptVarsResolver (the ITaskPromptVarsResolver adapter injected into
 * modules/sidekicks for `GET /api/sidekicks/:name?render=1&task_id=`), and
 * PhaseLoopRunner (state-machine / llm execution loops) — see Issue #263
 * Phase 5 plan ("コード共有。斜め実装しない"). Path-specific differences
 * (e.g. the execution loop's in-memory selfReview attempt counter) are applied
 * by the caller as explicit overrides on top of this result, never by
 * re-implementing the vars.
 *
 * `resolvedGitProvider` (optional): the git provider ("github"/"gitlab") of
 * whichever repository the CALLER already resolved as THE repository for
 * this run — i.e. `resolveExecutionRepositoryEntry`'s result
 * (`tasks/execution/DistributionHelper.ts`). That resolver lives one layer
 * above this module (`prompt` is mid-tier, `tasks/execution` is upper-tier;
 * see AGENTS.md's "Module Structure Rules"), so this module must not import
 * it — importing it here would invert the direction depcruise enforces.
 * Instead, upper-tier callers that already resolve the repository (right
 * now: `PhaseLoopRunner`) pass the provider value down as a plain string,
 * which is a normal upper-to-lower argument, not a dependency-direction
 * violation (Issue #87 review, 14th round — this replaces the previous
 * "known, low-severity inconsistency, deliberately left as-is" comment that
 * used to live here; that comment described choosing not to fix the mid/
 * upper layering conflict at all, which is no longer accurate now that the
 * conflict is resolved via this parameter).
 *
 * Callers that do NOT resolve a distribution-aware repository themselves —
 * `RenderSkillPromptUseCase` (the `/api/phase-prompts` render path) and
 * `TaskPromptVarsResolver` (the standalone `/api/sidekicks/:name?render=1`
 * adapter) — omit this argument, and `gitProvider` keeps its long-standing
 * `project.repositories[0]` default. Both are outside `tasks/execution`
 * (one is `prompt` itself, the other is `sidekicks`'s port), so neither can
 * resolve `resolveExecutionRepositoryEntry` without the same layering
 * problem this parameter exists to avoid; wiring them would need either a
 * new port passed into `prompt`/`sidekicks` or moving the resolver down a
 * layer, both out of this fix's scope.
 */
export function resolveTaskPromptVars(
  taskRepo: ITaskRepository,
  projectRepo: IProjectRepository,
  unitRepo: IUnitRepository,
  projectServerRepo: IProjectServerRepository,
  taskId: number,
  resolvedGitProvider?: string,
): TaskPromptVars {
  const task = taskRepo.findById(taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const project = projectRepo.findById(task.projectId);
  if (!project) {
    throw new Error(`Project not found: ${task.projectId}`);
  }

  const unit = task.unitId !== null ? unitRepo.findById(task.unitId) : null;
  const resolvedServerName = resolveTaskServerName(task, projectServerRepo);
  const projectServer = resolvedServerName ? projectServerRepo.find(task.projectId, resolvedServerName) : null;

  const promptModules = loadPromptModules();

  return {
    task: {
      title: task.title,
      description: task.description ?? '',
      plan: task.planMarkdown ?? '',
      targetBranch: task.targetBranch
        ? `- PR target branch: ${task.targetBranch} (if this branch does not exist, create it from ${task.baseBranch || project.defaultBranch || 'main'} before creating the PR)`
        : '',
      pushTaskDescription: task.skipPr
        ? 'Push the implementation. Do NOT create a new Pull Request.\nOnly commit and push the changes. If a PR already exists for this branch, update its title and body to reflect the changes.'
        : 'Push the implementation and create a Pull Request.',
      pushRules: task.skipPr
        ? ''
        : '- PR title should concisely describe the task\n- PR body should include a summary of changes and test results',
      pushOutput: task.skipPr
        ? 'Report the branch name that was pushed.'
        : 'Report the PR URL.',
      // See this function's doc comment above for `resolvedGitProvider`
      // (the distribution-aware value an upper-tier caller may pass in) —
      // falls back to `repositories[0]` for callers that can't resolve it.
      gitProvider: resolvedGitProvider ?? project.repositories?.[0]?.provider ?? 'github',
    },
    project: {
      sidekickPrompt: [project.sidekickPrompt, unit?.systemPrompt].filter(Boolean).join('\n\n'),
      // task.baseBranch (set when the worktree is created from a task-specific base)
      // wins over the project default — this is what the execution loop has always
      // used, so skill render and runtime render expand identically.
      defaultBranch: task.baseBranch || project.defaultBranch || 'main',
    },
    projectServer: {
      workingDirectory: task.workingDirectory || projectServer?.workingDirectory || '.',
      branch: projectServer?.branch ?? '',
    },
    selfReview: {
      attempt: String((task.selfReviewCount ?? 0) + 1),
      maxAttempts: String(unit?.selfReviewMaxAttempts ?? 2),
    },
    module: {
      reviewPerspectives: promptModules.reviewPerspectives,
      softwareDesignPrinciples: promptModules.softwareDesignPrinciples,
      uiDesignPrinciples: promptModules.uiDesignPrinciples,
    },
  };
}
