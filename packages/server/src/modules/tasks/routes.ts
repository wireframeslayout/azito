import type { FastifyPluginCallback } from 'fastify';
import type { ITaskRepository, Task } from './Task';
import { deriveInputTrust, validateTaskSourceFields } from './Task';
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
import { failAsyncTaskOperation } from './execution/AppendLog';
import { decideExecutionApproval, decideExecutionPreApproval, denyPendingApproval, resolvePendingApprovalManifest, type ApprovalOrigin } from './execution/ExecutionApprovalDecision';
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
    // Validates source/source_ref BEFORE deriveInputTrust() reads them below
    // (third-party review, task/328 follow-up) — see validateTaskSourceFields'
    // doc comment for why an unvalidated `source` can silently defeat the
    // untrusted-origin execution gate.
    const sourceFields = validateTaskSourceFields(source, source_ref);
    if ('error' in sourceFields) return reply.status(400).send({ error: sourceFields.error });
    try {
      const reviewSubagent = parseSubagentConfigInput(review_subagent, 'review_subagent');
      const implementSubagent = parseSubagentConfigInput(implement_subagent, 'implement_subagent');
      // input_trust is deliberately NOT read from request.body — see Task.ts.
      // It is DERIVED from `source` via deriveInputTrust() (Issue #328
      // hardening) — the same function POST /api/projects/:id/import-issue
      // uses — rather than hardcoded 'trusted'. The browser's actual
      // GitHub-issue-import flow (IssueDetailPanel -> TaskForm) posts here,
      // to this endpoint, with `source: 'github'`; the previous hardcoded
      // 'trusted' silently bypassed the execution gate for every task
      // created that way. A caller-supplied `source` therefore now decides
      // trust, not the endpoint used to reach this route.
      const resolvedSource = sourceFields.source ?? 'local';
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
        source: resolvedSource,
        sourceRef: sourceFields.sourceRef ?? null,
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
        inputTrust: deriveInputTrust(resolvedSource),
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
      if (!task) {
        return reply.status(404).send({ error: 'Task is not pending execution approval' });
      }
      // Creation-time pre-approval window (task/328 follow-up, part A):
      // a freshly created untrusted task that has NEVER been gate-blocked
      // (still status='open', pending_operation NULL) also has a live
      // manifest to display/approve — the create-form's own
      // create-then-pre-approve flow (TaskFormView) fetches this exact
      // response right after POST /api/tasks, the same way the
      // pending_approval panel does. Every other status still 404s
      // unchanged — this is additive, not a relaxation of the existing
      // pending_approval-only guard.
      const isPreApprovable = task.inputTrust === 'untrusted' && task.status === 'open' && task.pendingOperation === null;
      if (task.status !== 'pending_approval' && !isPreApprovable) {
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
      const body = request.body as { approved?: unknown; fingerprint?: unknown; origin?: unknown };
      if (typeof body.approved !== 'boolean') {
        return reply.status(400).send({ error: 'approved must be a boolean' });
      }
      if (body.approved && typeof body.fingerprint !== 'string') {
        return reply.status(400).send({ error: 'fingerprint is required when approving (fetch it from GET /api/tasks/:id/execution-approval)' });
      }
      // `origin` (task/328 follow-up, part B) — audit-only, see
      // ApprovalOrigin's doc comment. Validated as an enum, not passed
      // through as a free string: a caller cannot invent an unaudited-for
      // label, and this value is NEVER read by the approve/deny decision
      // below, only logged.
      let origin: ApprovalOrigin | undefined;
      if (body.origin !== undefined) {
        if (body.origin !== 'creation_form' && body.origin !== 'approval_panel' && body.origin !== 'mission_prompt') {
          return reply.status(400).send({ error: "origin must be 'creation_form', 'approval_panel', or 'mission_prompt'" });
        }
        origin = body.origin;
      }

      const project = projectRepo.findById(task.projectId);
      const unitId = resolveUnitId(task, project);

      // Creation-time pre-approval window (task/328 follow-up, part A-2): a
      // freshly created untrusted task that has NEVER been gate-blocked
      // (still status='open', pending_operation NULL) takes a separate,
      // narrower path — decideExecutionPreApproval() — that records approval
      // WITHOUT dispatching anything (see that function's own doc comment
      // for why decideExecutionApproval() itself, which always dispatches
      // the pendingOperation it consumes, cannot be reused for this).
      // Denial is not meaningful here (nothing is blocked to deny) — the
      // caller falls through to the ordinary 400 below.
      if (task.status === 'open' && task.inputTrust === 'untrusted' && task.pendingOperation === null && body.approved) {
        const outcome = decideExecutionPreApproval(
          { taskRepo, logRepo, unitRepo, projectRepo, projectServerRepo, serverRepo, projectSecretRepo, unitTypeLoader, sidekickLoader, events: executeTaskUseCase.events },
          { taskId, unitId, fingerprint: body.fingerprint as string, origin: origin ?? 'creation_form' },
          request.log,
        );
        return reply.status(outcome.status).send(outcome.body);
      }

      const outcome = decideExecutionApproval(
        { taskRepo, logRepo, unitRepo, projectRepo, projectServerRepo, serverRepo, projectSecretRepo, unitTypeLoader, sidekickLoader, windowRepo, respawnService, executeTaskUseCase, taskRestoreService },
        { taskId, unitId, approved: body.approved, fingerprint: body.approved ? (body.fingerprint as string) : undefined, origin },
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
      // A `pending_approval` task's status may only change through
      // POST /api/tasks/:id/approve-execution (Issue #328 review round) —
      // that endpoint atomically clears pendingOperation/
      // pendingOperationWindowId/pendingOperationPriorStatus together with
      // the status transition (consumePendingApproval). Accepting an
      // arbitrary `status` here would let a client move the task to e.g.
      // 'open' or 'done' while leaving pendingOperation set: the approval
      // screen (GET .../execution-approval) rejects because status is no
      // longer 'pending_approval', and checkExecutionGate blocks any new
      // run because pendingOperation is still non-null — a permanently
      // stuck task neither the approval UI nor the gate can recover.
      // StatusDropdown already locks 'pending_approval' client-side
      // (frontend/src/components/task/StatusDropdown.tsx); this is the
      // server-side enforcement of the same rule. The escape hatch for "I
      // don't want to approve this" is already POST .../approve-execution
      // with `approved: false` (denial), which atomically clears the
      // pending state via the same consumePendingApproval() call — so no
      // new revoke endpoint is needed.
      if (existing.status === ('pending_approval' as TaskStatus) && status !== undefined) {
        return reply.status(409).send({
          error: `Task ${id} is pending_approval; its status cannot be changed via PUT. Approve or deny via POST /api/tasks/${id}/approve-execution (denial clears the pending approval).`,
        });
      }
      // Same validation as POST /api/tasks (third-party review, task/328
      // follow-up) — see validateTaskSourceFields' doc comment.
      const sourceFields = validateTaskSourceFields(source, source_ref);
      if ('error' in sourceFields) return reply.status(400).send({ error: sourceFields.error });
      try {
        const reviewSubagent = review_subagent !== undefined
          ? parseSubagentConfigInput(review_subagent, 'review_subagent')
          : undefined;
        const implementSubagent = implement_subagent !== undefined
          ? parseSubagentConfigInput(implement_subagent, 'implement_subagent')
          : undefined;
        // inputTrust is derived from the EFFECTIVE `source` (the incoming
        // value if provided, else the task's existing source) via the same
        // deriveInputTrust() used at creation — but floored at the task's
        // CURRENT trust level so it can only move trusted -> untrusted, never
        // back (Issue #328: "信頼度を上げる方向の遷移は実装しないこと"). A
        // task already 'untrusted' stays 'untrusted' even if `source` is
        // edited back to 'local' — otherwise that edit would be exactly the
        // bypass this gate exists to prevent.
        const effectiveSource = sourceFields.source !== undefined ? sourceFields.source : existing.source;
        const nextInputTrust: Task['inputTrust'] =
          existing.inputTrust === 'untrusted' ? 'untrusted' : deriveInputTrust(effectiveSource);
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
          source: sourceFields.source,
          sourceRef: sourceFields.sourceRef,
          inputTrust: nextInputTrust !== existing.inputTrust ? nextInputTrust : undefined,
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
      // failAsyncTaskOperation() (AppendLog.ts) — same shared helper
      // ExecutionApprovalDecision.ts's failApprovedOperation and
      // approve-plan's failResumedOperation use, so this failure ALSO emits
      // on the shared events EventEmitter (not just logRepo.append()), and
      // therefore reaches other connected clients as a `task:status` WS
      // event / push notification instead of leaving them stuck showing
      // `waiting_input` forever.
      executeTaskUseCase.followUp(answerUnitId, id, followUpComment).catch((err: unknown) => {
        failAsyncTaskOperation({ taskRepo, logRepo, events: executeTaskUseCase.events, log: request.log }, id, answerUnitId, 'answer_followup', err, 'answer follow-up failed');
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

      // A `pending_approval` task carries an outstanding untrusted-input
      // execution gate (Issue #328) — this route used to overwrite `status`
      // to 'archived' directly while leaving `pendingOperation` set, the same
      // "changes status without touching the pending approval" bug the PUT
      // /api/tasks/:id guard above already closed for arbitrary status edits
      // (see that guard's own doc comment). Left as-is, the task became
      // simultaneously un-approvable (GET .../execution-approval 404s once
      // status is no longer 'pending_approval') and un-restorable
      // (checkExecutionGate still sees the leftover pendingOperation and
      // blocks the restore) — permanently stuck.
      //
      // Chosen fix: (b) consume the pending approval as a DENIAL, atomically,
      // before archiving — not (a) reject the archive with 409. "Archive this,
      // I don't need it anymore" already means "I don't want the pending
      // operation to run either"; forcing the human to separately deny it
      // first (via a UI screen that only shows for pending_approval tasks —
      // ExecutionApprovalPanel, gone the moment they navigate away to hit
      // archive) before they're allowed to archive would be a needless extra
      // step for a decision they've already made. denyPendingApproval()
      // reuses the SAME atomic consume + audit log path (`status_change` with
      // `reason: 'execution_denied'`, forwarded over the same WS `task:status`
      // bridge decideExecutionApproval's denial branch uses) so this leaves
      // an identical audit trail to an explicit Deny — just with `'archived'`
      // as the landing status instead of denial's usual 'failed' (this route
      // is about to set 'archived' below anyway).
      if (task.status === ('pending_approval' as TaskStatus)) {
        const project = projectRepo.findById(task.projectId);
        const unitId = resolveUnitId(task, project);
        const outcome = denyPendingApproval({ taskRepo, logRepo, executeTaskUseCase }, task, unitId, 'archived' as TaskStatus);
        if (!outcome.consumed) {
          return reply.status(409).send({ error: `Task ${id}'s pending approval was already resolved by a concurrent request` });
        }
      }

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
