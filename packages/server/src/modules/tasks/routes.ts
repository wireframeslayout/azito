import type { FastifyPluginCallback } from 'fastify';
import type { ITaskRepository, Task } from './Task';
import type { TaskStatus } from './TaskStatus';
import type { IProjectRepository } from '../projects/Project';
import type { IProjectServerRepository } from '../projects/ProjectServer';
import type { IExecutionLogRepository } from './ExecutionLog';
import type { ExecuteTaskUseCase } from './execution/ExecuteTaskUseCase';
import type { IUnitRepository, SubagentConfig } from '../units/Unit';
import type { TmuxClient } from '../tmux/TmuxClient';
import type { IServerRepository } from '../servers/Server';
import type { WorktreeServiceFactory } from '../git/WorktreeServiceFactory';
import type { TransportFactory } from '../servers/transport/TransportFactory';
import type { IWindowRepository } from '../windows/Window';
import type { WindowRespawnService } from '../windows/WindowRespawnService';
import type { TaskRestoreService } from './TaskRestoreService';
import type { SupervisorRegistry } from '../supervisors/SupervisorRegistry';
import { TaskCleanupService } from './TaskCleanupService';
import { SAFE_PATH_PATTERN, SAFE_BRANCH_PATTERN } from '../git/assertSafeGitArgs';
import { resolveTaskServerName, resolveTmuxSession, resolveUnitId } from './execution/TaskExecutionEnv';
import { shouldSupervise, wrapWithSupervisor } from '../supervisors/SupervisorLaunch';
import { checkExecutionGate, replyToExecutionGateError } from './execution/ExecutionGate';
import type { UnitTypeLoader } from '../sidekicks/UnitTypeLoader';

function parseSubagentConfigInput(raw: unknown, fieldName: string): SubagentConfig | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') throw new Error(`${fieldName} must be an object`);
  const obj = raw as Record<string, unknown>;
  if (typeof obj['enabled'] !== 'boolean') throw new Error(`${fieldName}.enabled must be boolean`);
  if (typeof obj['provider'] !== 'string') throw new Error(`${fieldName}.provider must be string`);
  if (typeof obj['model'] !== 'string') throw new Error(`${fieldName}.model must be string`);
  if (obj['enabled'] && (!obj['provider'] || !obj['model'])) {
    throw new Error(`${fieldName}: provider and model are required when enabled is true`);
  }
  return { enabled: obj['enabled'], provider: obj['provider'], model: obj['model'] };
}

function validateGitFields(body: Record<string, unknown>): string | null {
  for (const key of ['base_branch', 'branch', 'target_branch'] as const) {
    const v = body[key];
    if (v != null && v !== '' && (typeof v !== 'string' || !SAFE_BRANCH_PATTERN.test(v))) return `Invalid ${key}`;
  }
  for (const key of ['working_directory', 'worktree_path'] as const) {
    const v = body[key];
    if (v != null && v !== '' && (typeof v !== 'string' || !SAFE_PATH_PATTERN.test(v))) return `Invalid ${key}`;
  }
  return null;
}

// ─── Types ───

export interface TasksRouteOptions {
  taskRepo: ITaskRepository;
  projectRepo: IProjectRepository;
  projectServerRepo: IProjectServerRepository;
  logRepo: IExecutionLogRepository;
  executeTaskUseCase: ExecuteTaskUseCase;
  unitRepo: IUnitRepository;
  tmux: TmuxClient;
  serverRepo: IServerRepository;
  worktreeServiceFactory: WorktreeServiceFactory;
  transportFactory: TransportFactory;
  windowRepo: IWindowRepository;
  respawnService: WindowRespawnService;
  taskRestoreService: TaskRestoreService;
  supervisorRegistry: SupervisorRegistry;
  unitTypeLoader: UnitTypeLoader;
}

// ─── Plugin ───

/**
 * Fields kept out of the task *list* response. Each is a full document
 * (plan, description, summary, changed-file list) that only the detail panel
 * renders, and at a few hundred tasks they made up ~97% of the payload —
 * enough to dominate first paint on mobile networks. `GET /api/tasks/:id`
 * still returns the complete record; the panel fetches it when opened.
 */
const LIST_OMITTED_FIELDS = ['planMarkdown', 'description', 'summaryJson', 'changedFiles'] as const;

function toListItem(task: Task, windows: unknown[]): Record<string, unknown> {
  const item: Record<string, unknown> = { ...task, windows };
  for (const field of LIST_OMITTED_FIELDS) delete item[field];
  return item;
}

const tasksRoutes: FastifyPluginCallback<TasksRouteOptions> = (fastify, opts, done) => {
  const { taskRepo, projectRepo, projectServerRepo, logRepo, executeTaskUseCase, unitRepo, tmux, serverRepo, worktreeServiceFactory, transportFactory, windowRepo, respawnService, taskRestoreService, supervisorRegistry, unitTypeLoader } = opts;
  const taskCleanupService = new TaskCleanupService({ serverRepo, tmux, worktreeServiceFactory, transportFactory, projectServerRepo, projectRepo });

  // ── GET /api/tasks ──
  fastify.get<{
    Querystring: { project_id?: string; status?: string; unit_id?: string };
  }>('/api/tasks', async (request) => {
    const { project_id, status, unit_id } = request.query;
    let tasks: Task[];
    if (project_id) {
      tasks = taskRepo.findByProject(parseInt(project_id, 10));
    } else if (unit_id) {
      tasks = taskRepo.findByUnit(parseInt(unit_id, 10));
    } else if (status) {
      tasks = taskRepo.findByStatus(status as TaskStatus);
    } else {
      tasks = taskRepo.findAll();
    }
    const windowsByTask = windowRepo.findByTaskIds(tasks.map((t) => t.id));
    return tasks.map((t) => toListItem(t, windowsByTask.get(t.id) ?? []));
  });

  // ── POST /api/tasks ──
  fastify.post('/api/tasks', async (request, reply) => {
    const {
      project_id,
      unit_id,
      server_name,
      title,
      description,
      priority,
      tmux_window,
      self_review_max_attempts,
      source,
      source_ref,
      require_plan_approval,
      base_branch,
      target_branch,
      skip_pr,
      working_directory,
      branch,
      changed_files,
      pr_url,
      review_subagent,
      implement_subagent,
    } = request.body as Record<string, unknown>;
    const gitError = validateGitFields(request.body as Record<string, unknown>);
    if (gitError) return reply.status(400).send({ error: gitError });
    if (!project_id || !title)
      return reply.status(400).send({ error: 'project_id, title required' });
    if (!projectRepo.findById(project_id as number))
      return reply.status(404).send({ error: 'Project not found' });
    try {
      const reviewSubagent = parseSubagentConfigInput(review_subagent, 'review_subagent');
      const implementSubagent = parseSubagentConfigInput(implement_subagent, 'implement_subagent');
      // input_trust is deliberately NOT read from request.body — see Task.ts.
      //
      // Issue #328 asks this endpoint to inherit the parent task's trust level
      // when an agent creates a sub-task and the parent is identifiable. There
      // is currently no way to identify a calling agent's task from an HTTP
      // request: every request (browser UI and any in-pane `curl`/MCP call
      // alike) authenticates with the single shared AZITO_UI_TOKEN — there is
      // no per-task credential or header carrying a "calling task id" (verified
      // against app/buildServer.ts's createTokenVerifier and the harness
      // worker launch env, which only injects AZITO_SECRET_*/AZITO_AGENT_*).
      // Until such a signal exists, this endpoint cannot distinguish "human
      // via the UI" from "agent via the API", so it defaults to 'trusted' —
      // the same as it always has — rather than guess. This must never be
      // 'untrusted' by construction here; only server-only paths (currently
      // POST /api/projects/:id/import-issue) mark a task untrusted, since the
      // trust-lowering direction is safe but trust-raising is not (Issue #328:
      // "信頼度を上げる方向の遷移は実装しないこと").
      const id = taskRepo.create({
        projectId: project_id as number,
        unitId: (unit_id as number) ?? null,
        serverName: (server_name as string) ?? null,
        title: title as string,
        description: (description as string) ?? null,
        status: 'open',
        currentPhase: null,
        selfReviewCount: 0,
        priority: (priority as number) ?? 0,
        tmuxWindow: (tmux_window as string) ?? null,
        selfReviewMaxAttempts: self_review_max_attempts != null ? (self_review_max_attempts as number) : null,
        requirePlanApproval: require_plan_approval !== false,
        source: (source as 'local' | 'github' | 'gitlab') ?? 'local',
        sourceRef: (source_ref as string) ?? null,
        worktreePath: null,
        worktreeBranch: null,
        baseBranch: (base_branch as string) ?? null,
        targetBranch: (target_branch as string) ?? null,
        skipPr: !!skip_pr,
        workingDirectory: (working_directory as string) || null,
        branch: (branch as string) ?? null,
        planMarkdown: null,
        pendingQuestions: null,
        changedFiles: (changed_files as string) ?? null,
        summaryJson: null,
        prUrl: (pr_url as string) ?? null,
        agentSessionId: null,
        reviewSubagent,
        implementSubagent,
        inputTrust: 'trusted',
        executionApprovedFingerprintHash: null,
        pendingOperation: null,
      });
      return { ok: true, id };
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── GET /api/tasks/:id ──
  fastify.get<{ Params: { id: string } }>(
    '/api/tasks/:id',
    async (request, reply) => {
      const t = taskRepo.findById(parseInt(request.params.id, 10));
      if (!t) return reply.status(404).send({ error: 'Task not found' });

      let paneAlive: boolean | null = null;
      if (t.tmuxWindow) {
        const resolvedServerName = resolveTaskServerName(t, projectServerRepo);
        const srv = resolvedServerName ? serverRepo.findByName(resolvedServerName) : null;
        if (resolvedServerName && srv) {
          const tmuxSession = resolveTmuxSession(t.projectId, resolvedServerName, projectServerRepo);
          paneAlive = await tmux.checkPaneExists(srv, `${tmuxSession}:${t.tmuxWindow}`);
        }
      }

      const windows = windowRepo.findByTask(t.id);

      let unitTypeInfo: { name: string; phases: Array<{ name: string; label: string }> } | null = null;
      const project = projectRepo.findById(t.projectId);
      const resolvedUnitId = resolveUnitId(t, project);
      if (resolvedUnitId !== null) {
        const unit = unitRepo.findById(resolvedUnitId);
        if (unit) {
          const ut = unitTypeLoader.get(unit.unitType);
          if (ut) {
            unitTypeInfo = { name: ut.name, phases: ut.phases.map((p) => ({ name: p.name, label: p.label })) };
          }
        }
      }

      return { ...t, paneAlive, windows, unitType: unitTypeInfo };
    },
  );

  // ── PUT /api/tasks/:id ──
  fastify.put<{ Params: { id: string } }>(
    '/api/tasks/:id',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const existing = taskRepo.findById(id);
      if (!existing) return reply.status(404).send({ error: 'Task not found' });
      const { title, description, status, unit_id, server_name, priority, tmux_window, self_review_max_attempts, require_plan_approval, base_branch, target_branch, skip_pr, working_directory, branch, changed_files, pr_url, source, source_ref, review_subagent, implement_subagent, worktree_path, worktree_branch } =
        request.body as Record<string, unknown>;
      const gitError = validateGitFields(request.body as Record<string, unknown>);
      if (gitError) return reply.status(400).send({ error: gitError });
      // Only the untrusted-input-gate direction is enforced here: an
      // untrusted task may not have its own plan-approval requirement turned
      // off (that would let it skip straight to unattended execution).
      // Turning it ON (true) is always allowed. `source`/`source_ref` remain
      // freely editable below (for /azt-link) — inputTrust itself is not
      // settable from this body at all, so this check is the only place
      // trust level constrains what else can change (Issue #328).
      if (existing.inputTrust === 'untrusted' && require_plan_approval === false) {
        return reply.status(400).send({ error: 'require_plan_approval cannot be disabled for an untrusted-origin task' });
      }
      try {
        const reviewSubagent = review_subagent !== undefined
          ? parseSubagentConfigInput(review_subagent, 'review_subagent')
          : undefined;
        const implementSubagent = implement_subagent !== undefined
          ? parseSubagentConfigInput(implement_subagent, 'implement_subagent')
          : undefined;
        taskRepo.update(id, {
          title: (title as string) || existing.title,
          description:
            description !== undefined ? (description as string) : existing.description,
          status: (status as TaskStatus) || existing.status,
          unitId:
            unit_id !== undefined ? ((unit_id as number | null) ?? null) : existing.unitId,
          serverName:
            server_name !== undefined ? ((server_name as string | null) ?? null) : existing.serverName,
          priority: priority !== undefined ? (priority as number) : existing.priority,
          tmuxWindow:
            tmux_window !== undefined ? (tmux_window as string) : existing.tmuxWindow,
          selfReviewMaxAttempts:
            self_review_max_attempts !== undefined ? (self_review_max_attempts as number) : undefined,
          requirePlanApproval:
            require_plan_approval !== undefined ? !!(require_plan_approval as boolean) : undefined,
          baseBranch: base_branch !== undefined ? (base_branch as string) : undefined,
          targetBranch: target_branch !== undefined ? (target_branch as string) : undefined,
          skipPr: skip_pr !== undefined ? !!(skip_pr as boolean) : undefined,
          workingDirectory: working_directory !== undefined ? ((working_directory as string) || null) : undefined,
          branch: branch !== undefined ? (branch as string) : undefined,
          changedFiles: changed_files !== undefined ? (changed_files as string) : undefined,
          prUrl: pr_url !== undefined ? (pr_url as string) : undefined,
          source: source !== undefined ? (source as 'local' | 'github' | 'gitlab') : undefined,
          sourceRef: source_ref !== undefined ? (source_ref as string) : undefined,
          reviewSubagent,
          implementSubagent,
          worktreePath: worktree_path !== undefined ? (worktree_path as string) : undefined,
          worktreeBranch: worktree_branch !== undefined ? (worktree_branch as string) : undefined,
        } as Partial<import('./Task').Task>);
        return { ok: true };
      } catch (err: unknown) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  // ── DELETE /api/tasks/:id ──
  fastify.delete<{ Params: { id: string } }>(
    '/api/tasks/:id',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const task = taskRepo.findById(id);
      if (!task) return reply.status(404).send({ error: 'Task not found' });

      executeTaskUseCase.stopByTaskId(id);
      await taskCleanupService.cleanup(task, request.log);
      taskRepo.delete(id);
      return { ok: true };
    },
  );

  // ── GET /api/tasks/:id/logs ──
  fastify.get<{ Params: { id: string } }>(
    '/api/tasks/:id/logs',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      if (!taskRepo.findById(id))
        return reply.status(404).send({ error: 'Task not found' });
      return logRepo.findByTask(id);
    },
  );

  // ── GET /api/tasks/:id/health ──
  fastify.get<{ Params: { id: string } }>(
    '/api/tasks/:id/health',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const task = taskRepo.findById(id);
      if (!task) return reply.status(404).send({ error: 'Task not found' });

      const STALE_THRESHOLD_MINUTES = 5;
      const updatedAt = new Date(task.updatedAt + (task.updatedAt.endsWith('Z') ? '' : 'Z'));
      const now = new Date();
      const diffMs = now.getTime() - updatedAt.getTime();
      const diffMinutes = Math.floor(diffMs / 60_000);
      const isStale = task.status === 'in_progress' && diffMinutes >= STALE_THRESHOLD_MINUTES;

      return {
        stale: isStale,
        lastActivityAt: task.updatedAt,
        staleSinceMinutes: isStale ? diffMinutes : 0,
      };
    },
  );

  // ── POST /api/tasks/:id/retry ──
  fastify.post<{ Params: { id: string } }>(
    '/api/tasks/:id/retry',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const task = taskRepo.findById(id);
      if (!task) return reply.status(404).send({ error: 'Task not found' });

      const retryableStatuses: TaskStatus[] = ['in_progress', 'failed'];
      if (!retryableStatuses.includes(task.status)) {
        return reply.status(400).send({ error: `Task status '${task.status}' is not retryable` });
      }

      // Try to stop any running execution for this task
      executeTaskUseCase.stopByTaskId(id);

      // Reset task status and clear tmux window
      taskRepo.update(id, { status: 'open' as TaskStatus, tmuxWindow: null });

      return { ok: true };
    },
  );

  // ── POST /api/tasks/:id/answer ──
  fastify.post<{ Params: { id: string } }>(
    '/api/tasks/:id/answer',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const task = taskRepo.findById(id);
      if (!task) return reply.status(404).send({ error: 'Task not found' });

      if (task.status !== 'review' && task.status !== 'waiting_input') {
        return reply.status(400).send({ error: 'Task is not waiting for answers' });
      }

      const { answers, additionalComment } = request.body as { answers: Array<{ index: number; value: string | number }>; additionalComment?: string };
      if (!answers || !Array.isArray(answers)) {
        return reply.status(400).send({ error: 'answers array is required' });
      }

      // Same Unit resolution as ExecuteTaskUseCase.resolveExecutionEnv
      // (task.unitId ?? project.defaultUnitId) so follow-up resumes with the
      // exact Unit the execution runs/logs under.
      const answerUnitId = resolveUnitId(task, projectRepo.findById(task.projectId));
      if (!answerUnitId) return reply.status(400).send({ error: 'Task has no unit assigned and its project has no default unit' });
      const unit = unitRepo.findById(answerUnitId);
      if (!unit) return reply.status(404).send({ error: 'Unit not found' });

      const resolvedServerName = resolveTaskServerName(task, projectServerRepo);
      const server = resolvedServerName ? serverRepo.findByName(resolvedServerName) : null;
      if (!server) return reply.status(404).send({ error: 'Server not found' });

      const questions = task.pendingQuestions ? JSON.parse(task.pendingQuestions) as Array<{ text: string; type: string; options?: string[] }> : [];

      // Build human-readable answer text for the agent
      const answerLines = answers.map((answer) => {
        const question = questions[answer.index];
        if (!question) return null;
        const answerText = question.type === 'select' && typeof answer.value === 'number' && question.options
          ? question.options[answer.value] ?? String(answer.value)
          : String(answer.value);
        return `Q: ${question.text}\nA: ${answerText}`;
      }).filter(Boolean);

      let followUpComment = answerLines.length > 0
        ? `Here are the answers to your questions:\n\n${answerLines.join('\n\n')}\n\nPlease continue with the task based on these answers.`
        : 'User confirmed. Continue with the task.';
      if (additionalComment) {
        followUpComment += `\n\nAdditional instructions from the user:\n${additionalComment}`;
      }

      // Clear pending questions and resume task
      taskRepo.update(id, { pendingQuestions: null } as Partial<import('./Task').Task>);
      logRepo.append(id, answerUnitId, 'status_change', { status: 'answers_submitted', answers });

      // Resume execution via followUp with actual answer content
      // Keep current status (waiting_input) so followUp can resolve the correct phase
      executeTaskUseCase.followUp(answerUnitId, id, followUpComment).catch(() => {});

      return { ok: true };
    },
  );

  // ── POST /api/tasks/:id/recover-session (backward-compat wrapper) ──
  fastify.post<{ Params: { id: string } }>(
    '/api/tasks/:id/recover-session',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const task = taskRepo.findById(id);
      if (!task) return reply.status(404).send({ error: 'Task not found' });

      const windows = windowRepo.findByTask(id);
      const primaryWindow = windows.find((w) => w.isPrimary);

      if (primaryWindow) {
        const srv = serverRepo.findByName(primaryWindow.serverName);
        if (!srv) return reply.status(404).send({ error: 'Server not found' });

        // respawnService.respawn() runs the untrusted-input execution gate
        // (Issue #328) itself before touching tmux — this route only needs
        // to translate its errors into a response, same as /api/units/:id/
        // execute|follow-up and /api/windows/:id/respawn.
        let result: { tmuxTarget: string };
        try {
          result = await respawnService.respawn(primaryWindow.id, srv);
        } catch (err) {
          if (replyToExecutionGateError(err, reply)) return;
          throw err;
        }
        const windowName = task.tmuxWindow || `task-${task.id}`;
        taskRepo.update(id, { tmuxWindow: windowName } as Partial<Task>);

        return { tmuxWindow: windowName, tmuxTarget: result.tmuxTarget };
      }

      // Fallback for tasks without window records (pre-migration 034). This
      // path creates a tmux window and launches `claude --resume` directly
      // (no WindowRespawnService involved), so it needs its own execution
      // gate check (Issue #328) — otherwise a legacy task with no window
      // record could resume regardless of inputTrust/input_policy.
      if (!task.agentSessionId) return reply.status(400).send({ error: 'No primary window or agent session ID' });
      const resolvedServerName = resolveTaskServerName(task, projectServerRepo);
      const server = resolvedServerName ? serverRepo.findByName(resolvedServerName) : null;
      if (!resolvedServerName || !server) return reply.status(404).send({ error: 'Server not found' });

      const project = projectRepo.findById(task.projectId);
      const projectServer = project ? projectServerRepo.find(task.projectId, resolvedServerName) : null;
      const gate = checkExecutionGate(task, projectServer);
      if (!gate.allowed) {
        const gateUnitId = resolveUnitId(task, project);
        if (gateUnitId !== null) {
          logRepo.append(id, gateUnitId, 'command', { type: 'execution_gate_blocked', reason: gate.reason });
        }
        if (gate.reason === 'pending_approval') {
          taskRepo.updateStatus(id, 'pending_approval');
          return reply.status(409).send({ error: 'execution_pending_approval', message: `Task ${id}: execution requires approval (untrusted-origin task)` });
        }
        return reply.status(403).send({ error: 'execution_denied', message: `Task ${id}: execution denied by project server input policy (untrusted-origin task)` });
      }

      const tmuxSession = resolveTmuxSession(task.projectId, resolvedServerName, projectServerRepo);

      const { windowName: newWindowName } = await tmux.createWindow(server, tmuxSession, `task-${task.id}`);
      const windowTarget = `${tmuxSession}:${newWindowName}`;
      const paneId = await tmux.resolvePaneId(server, windowTarget);
      const resumeCommand = `claude --resume ${task.agentSessionId} --dangerously-skip-permissions`;
      const isSupervised = shouldSupervise(server.type, 'agent');
      if (isSupervised) {
        supervisorRegistry.clearExitMarker(server.name, windowTarget);
      }
      const sendCmd = isSupervised
        ? wrapWithSupervisor(resumeCommand, { server, target: windowTarget, taskId: id, unitId: task.unitId ?? undefined })
        : resumeCommand;
      await tmux.sendKeys(server, paneId, [sendCmd, 'Enter']);
      taskRepo.update(id, { tmuxWindow: newWindowName } as Partial<Task>);

      return { tmuxWindow: newWindowName };
    },
  );

  // ── POST /api/tasks/:id/archive ──
  fastify.post<{ Params: { id: string } }>(
    '/api/tasks/:id/archive',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const task = taskRepo.findById(id);
      if (!task) return reply.status(404).send({ error: 'Task not found' });
      if (task.status === 'archived') return { ok: true };

      executeTaskUseCase.stopByTaskId(id);
      await taskCleanupService.cleanup(task, request.log);
      for (const win of windowRepo.findByTask(id)) {
        windowRepo.remove(win.id);
      }
      taskRepo.update(id, { status: 'archived' as TaskStatus, tmuxWindow: null });
      return { ok: true };
    },
  );

  // ── POST /api/tasks/:id/restore ──
  fastify.post<{ Params: { id: string } }>(
    '/api/tasks/:id/restore',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const task = taskRepo.findById(id);
      if (!task) return reply.status(404).send({ error: 'Task not found' });
      if (task.status !== 'archived') {
        return reply.status(400).send({ error: `Task status '${task.status}' is not restorable` });
      }
      try {
        const result = await taskRestoreService.restore(task, request.log);
        return { ok: true, tmuxTarget: result.tmuxTarget, worktreePath: result.worktreePath };
      } catch (err) {
        // Gate-blocked restores (Issue #328) become 409/403, not a generic
        // 500 — same conversion every other execution entry point applies
        // (see replyToExecutionGateError's doc comment for the full list).
        if (replyToExecutionGateError(err, reply)) return;
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  done();
};

export default tasksRoutes;
