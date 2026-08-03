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
 */
export function resolveTaskPromptVars(
  taskRepo: ITaskRepository,
  projectRepo: IProjectRepository,
  unitRepo: IUnitRepository,
  projectServerRepo: IProjectServerRepository,
  taskId: number,
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
      gitProvider: project.repositories?.[0]?.provider ?? 'github',
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
