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
import { TaskCleanupService } from './TaskCleanupService';
import { SAFE_PATH_PATTERN, SAFE_BRANCH_PATTERN } from '../git/assertSafeGitArgs';
import { resolveTaskServerName, resolveTmuxSession, resolveUnitId } from './execution/TaskExecutionEnv';
import { replyToExecutionGateError } from './execution/ExecutionGate';
import { hashExecutionManifest } from './execution/ExecutionManifest';
import { decideExecutionApproval, resolvePendingApprovalManifest } from './execution/ExecutionApprovalDecision';
import type { UnitTypeLoader } from '../sidekicks/UnitTypeLoader';
import type { SidekickPackageLoader } from '../sidekicks/SidekickPackageLoader';
import type { SqliteProjectSecretRepository } from '../projects/SqliteProjectSecretRepository';

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
  unitTypeLoader: UnitTypeLoader;
  // Needed by GET /api/tasks/:id/execution-approval to resolve the same
  // execution manifest resolveExecutionManifest() produces for the gate
  // check itself (Issue #328/#51) — see that endpoint's comment for why a
  // second, hand-rolled resolution would risk showing the approver
  // something other than what actually gets hashed/executed.
  sidekickLoader: SidekickPackageLoader;
  projectSecretRepo: SqliteProjectSecretRepository;
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
  const { taskRepo, projectRepo, projectServerRepo, logRepo, executeTaskUseCase, unitRepo, tmux, serverRepo, worktreeServiceFactory, transportFactory, windowRepo, respawnService, taskRestoreService, unitTypeLoader, sidekickLoader, projectSecretRepo } = opts;
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
        pendingOperationWindowId: null,
        pendingOperationPriorStatus: null,
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

  // ── GET /api/tasks/:id/execution-approval ──
  //
  // What a human needs to see to approve/deny the untrusted-input execution
  // gate (Issue #51/#328) — the browser previously had no way to fetch this,
  // so an untrusted task blocked on `pending_approval` had no path forward
  // from the UI at all.
  //
  // Resolved through resolveExecutionManifest() — the SAME function the
  // approve-execution handler below hashes and gates on — rather
  // than a second, hand-rolled resolution. Two resolution paths for "what
  // will this task do" is exactly how earlier ExecutionManifest.ts review
  // rounds found drift bugs (see that file's module doc comment); this
  // endpoint reuses the same resolution and only reshapes it for display.
  //
  // 404 for a task that is not currently `pending_approval`: this resource
  // represents a live approval decision, not a historical record of one —
  // there is nothing meaningful to approve/deny once the task has moved on
  // (approved-and-running, denied-and-failed, or never gated at all), and a
  // stale UI polling this after the human already acted elsewhere should see
  // "gone", not a manifest for a decision that no longer applies.
  fastify.get<{ Params: { id: string } }>(
    '/api/tasks/:id/execution-approval',
    async (request, reply) => {
      const task = taskRepo.findById(parseInt(request.params.id, 10));
      if (!task || task.status !== 'pending_approval') {
        return reply.status(404).send({ error: 'Task is not pending execution approval' });
      }

      // Resolved via resolvePendingApprovalManifest() — the SAME helper
      // decideExecutionApproval() calls to re-resolve/re-hash at approval
      // time (Issue #328 fourteenth-round review). Before this helper
      // existed, this GET handler always resolved the non-respawn manifest,
      // while the approval handler resolved a DIFFERENT manifest whenever
      // `pendingOperation === 'respawn'` — so the fingerprint shown here
      // could never match what POST re-hashed, and respawn approval was
      // permanently stuck at `fingerprint_mismatch`. A missing respawn
      // window throws rather than silently falling back to the wrong
      // manifest; surfaced here as a 409, not a display of stale/incorrect
      // data.
      let manifest: ReturnType<typeof resolvePendingApprovalManifest>['manifest'];
      let unit: ReturnType<typeof resolvePendingApprovalManifest>['unit'];
      let serverName: ReturnType<typeof resolvePendingApprovalManifest>['serverName'];
      let projectServer: ReturnType<typeof resolvePendingApprovalManifest>['projectServer'];
      try {
        ({ manifest, unit, serverName, projectServer } = resolvePendingApprovalManifest(task, {
          unitRepo, projectRepo, projectServerRepo, serverRepo, projectSecretRepo, unitTypeLoader, sidekickLoader, windowRepo,
        }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(409).send({ error: message, code: 'pending_operation_window_missing' });
      }

      // Secret NAMES for display only — resolveExecutionManifest()
      // deliberately hashes only a digest of the sorted name set (see
      // ExecutionManifest.ts's `secrets.namesDigest` doc comment: plaintext
      // names, let alone values, are not something the approval hash itself
      // needs to carry). The approval screen needs the actual names, not a
      // digest a human can't read, so they're read here directly from the
      // same repository/query resolveExecutionManifest() reads its digest
      // input from — not a differently-scoped or differently-filtered read.
      const secretNames = projectSecretRepo.findByProject(task.projectId).map((s) => s.name).sort();

      return {
        taskId: task.id,
        title: task.title,
        description: task.description,
        inputTrust: task.inputTrust,
        pendingOperation: task.pendingOperation,
        inputPolicy: projectServer?.inputPolicy ?? null,
        // Fingerprint of the manifest THIS RESPONSE displays (Issue #328
        // review fix 1) — the client must send it back unchanged with
        // POST /api/tasks/:id/approve-execution's `approved: true`. The
        // approval handler re-resolves and re-hashes the manifest at the
        // moment of approval and rejects with 409 if it no longer matches
        // this value, closing the TOCTOU window between a human reading
        // this screen and clicking approve (task/Unit/Sidekick/server/
        // secrets could otherwise be edited out from under them in
        // between, with the stale screen never refreshing on its own).
        fingerprint: hashExecutionManifest(manifest),
        execution: {
          // Included alongside unitName for display — POST
          // /api/tasks/:id/approve-execution resolves the Unit itself (same
          // resolution used here) from the taskId alone, so this field is
          // shown, not addressed with. It is the RESOLVED Unit id — unlike
          // task.unitId, which is null whenever the task inherits the
          // project's defaultUnitId.
          unitId: unit?.id ?? null,
          unitName: unit?.name ?? null,
          serverName,
          workingDirectory: task.workingDirectory || manifest.server.workingDirectory,
          branches: manifest.branches,
          phases: manifest.phases.map((p) => {
            const sidekick = manifest.sidekicks.find((s) => s.phase === p.phase);
            return { phase: p.phase, sidekickName: sidekick?.name ?? null };
          }),
          repository: manifest.repository,
        },
        secretNames,
      };
    },
  );

  // ── POST /api/tasks/:id/approve-execution ──
  //
  // Task-scoped approve/deny for the untrusted-input execution gate (Issue
  // #328 review fix 2) — the SOLE entry point (hardening follow-up: a prior
  // Unit-scoped POST /api/units/:id/approve-execution was removed because it
  // reached the exact same gate without requiring `fingerprint`, silently
  // defeating the TOCTOU close fix 1 below exists for). Addressed by taskId
  // alone (matching GET .../execution-approval above) rather than requiring
  // the task's resolved Unit id in the URL: a task whose Unit cannot be
  // resolved (no unit_id on the task AND no defaultUnitId on its project;
  // TaskRestoreService.restore's gate can block such a task, see its own doc
  // comment) still has to be at least deniable. This route resolves the Unit
  // itself — tolerating null, same as resolveExecutionManifest/
  // TaskRestoreService already do.
  //
  // Dispatches via decideExecutionApproval() — see that function's doc
  // comment for the full per-operation rationale. `fingerprint` (Issue #328
  // review fix 1) is REQUIRED whenever `approved` is true: this is the route
  // the browser approval screen submits to, and the whole point of fix 1 is
  // that an approval must be tied to the exact manifest the human looking at
  // that screen saw, not to whatever the CURRENT manifest happens to be.
  fastify.post<{ Params: { id: string } }>(
    '/api/tasks/:id/approve-execution',
    async (request, reply) => {
      const taskId = parseInt(request.params.id, 10);
      const task = taskRepo.findById(taskId);
      if (!task) return reply.status(404).send({ error: 'Task not found' });

      // Runtime-validated, not just type-asserted: this endpoint flips a
      // security gate, so a truthy-but-wrong `approved` (e.g. the string
      // "false" — truthy) must not slip through as approval.
      const body = request.body as { approved?: unknown; fingerprint?: unknown };
      if (typeof body.approved !== 'boolean') {
        return reply.status(400).send({ error: 'approved must be a boolean' });
      }
      if (body.approved && typeof body.fingerprint !== 'string') {
        return reply.status(400).send({ error: 'fingerprint is required when approving (fetch it from GET /api/tasks/:id/execution-approval)' });
      }

      const project = projectRepo.findById(task.projectId);
      const unitId = resolveUnitId(task, project);

      const outcome = decideExecutionApproval(
        { taskRepo, logRepo, unitRepo, projectRepo, projectServerRepo, serverRepo, projectSecretRepo, unitTypeLoader, sidekickLoader, windowRepo, respawnService, executeTaskUseCase, taskRestoreService },
        { taskId, unitId, approved: body.approved, fingerprint: body.approved ? (body.fingerprint as string) : undefined },
        request.log,
      );
      return reply.status(outcome.status).send(outcome.body);
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
      // require_plan_approval must be validated as an actual boolean before
      // it is used for anything — otherwise `!!` coercion downstream would
      // let non-boolean falsy values (null/0/'') silently masquerade as
      // `false` and bypass the untrusted-origin gate below.
      if (require_plan_approval !== undefined && typeof require_plan_approval !== 'boolean') {
        return reply.status(400).send({ error: 'require_plan_approval must be a boolean' });
      }
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
            require_plan_approval !== undefined ? (require_plan_approval as boolean) : undefined,
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

      // Untrusted-input execution gate (Issue #328), checked synchronously
      // BEFORE anything below consumes task.pendingQuestions or the
      // submitted answers. followUp() runs this same check internally, but
      // by then it's too late: the answer route used to clear
      // pendingQuestions and fire followUp() with `.catch(() => {})` before
      // knowing whether the gate would block it, so a block silently lost
      // both the question record (needed to resubmit) and the human's
      // answer text (never persisted anywhere), while the client had already
      // been told `{ ok: true }` (sixth-round review finding 1). Checking
      // here first, with nothing mutated yet, means a block leaves
      // pendingQuestions/task.status exactly as they were and returns 409 —
      // the human can resubmit the same answers from the same screen once a
      // human approves via POST /api/tasks/:id/approve-execution.
      //
      // 'resume_await_answer', NOT plain 'resume' (Issue #328 seventh-round
      // review symptom A): plain 'resume' is auto-resumed via
      // resumeStateMachine() by the approval handler, which would restart the
      // task WITHOUT the answers ever reaching it (they are never persisted
      // above this check). The approval handler instead restores task.status
      // to pendingOperationPriorStatus ('waiting_input') and leaves it for
      // the human to resubmit this same /answer call. See the transition
      // table on Task.pendingOperation.
      try {
        executeTaskUseCase.enforceExecutionGate(task, answerUnitId, 'resume_await_answer');
      } catch (err) {
        if (replyToExecutionGateError(err, reply)) return;
        throw err;
      }

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
      // Keep current status (waiting_input) so followUp can resolve the correct phase.
      // followUp() re-runs the same execution gate checked above synchronously,
      // but nothing awaits between the two calls, so it cannot newly block here —
      // any rejection from this point on is a genuine run failure (tmux/worker/env
      // resolution), not a gate block, and must not be swallowed silently: same
      // failure-handling convention as approve-execution's failApprovedOperation
      // (ExecutionApprovalDecision.ts) for every other fire-and-forget resume call.
      executeTaskUseCase.followUp(answerUnitId, id, followUpComment).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        request.log.error({ err, taskId: id }, 'answer follow-up failed');
        logRepo.append(id, answerUnitId, 'command', { type: 'answer_followup_failed', message });
        taskRepo.update(id, { status: 'failed' as TaskStatus } as Partial<import('./Task').Task>);
      });

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
      // (no Window row involved) via WindowRespawnService.resumeLegacySession,
      // which runs its own execution gate check (Issue #328) — otherwise a
      // legacy task with no window record could resume regardless of
      // inputTrust/input_policy. Lives on the service (not inline here) so
      // the approve-execution handler can resume the exact same blocked
      // operation instead of duplicating this tmux/supervisor wiring
      // (Issue #328 fourth-round review finding 2).
      if (!task.agentSessionId) return reply.status(400).send({ error: 'No primary window or agent session ID' });
      const resolvedServerName = resolveTaskServerName(task, projectServerRepo);
      const server = resolvedServerName ? serverRepo.findByName(resolvedServerName) : null;
      if (!resolvedServerName || !server) return reply.status(404).send({ error: 'Server not found' });

      let legacyResult: { windowName: string };
      try {
        legacyResult = await respawnService.resumeLegacySession(id, server);
      } catch (err) {
        if (replyToExecutionGateError(err, reply)) return;
        throw err;
      }

      return { tmuxWindow: legacyResult.windowName };
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
