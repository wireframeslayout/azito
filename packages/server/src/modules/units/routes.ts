import type { FastifyPluginCallback } from 'fastify';
import type { IUnitRepository, SubagentConfig, WorkerExecutionMode, WorkerRuntime } from './Unit';
import type { ITaskRepository } from '../tasks/Task';
import type { TaskStatus } from '../tasks/TaskStatus';
import type { IExecutionLogRepository } from '../tasks/ExecutionLog';
import type { ExecuteTaskUseCase } from '../tasks/execution/ExecuteTaskUseCase';
import type { IProjectRepository } from '../projects/Project';
import type { SidekickPackageLoader } from '../sidekicks/SidekickPackageLoader';
import type { PhaseConfig, PhaseEntryConfig } from '../sidekicks/PhaseConfig';
import type { UnitTypeLoader } from '../sidekicks/UnitTypeLoader';
import { resolvePhaseSidekick } from '../sidekicks/resolvePhaseSidekick';
import { ResourceExhaustedError } from '../servers/resources/ResourceGuard';
import { ExecutionGateDeniedError, ExecutionGatePendingApprovalError, hashTaskDescription } from '../tasks/execution/ExecutionGate';
import { resolveUnitId } from '../tasks/execution/TaskExecutionEnv';

// ─── Types ───

export interface UnitsRouteOptions {
  unitRepo: IUnitRepository;
  taskRepo: ITaskRepository;
  logRepo: IExecutionLogRepository;
  executeTaskUseCase: ExecuteTaskUseCase;
  projectRepo: IProjectRepository;
  sidekickLoader: SidekickPackageLoader;
  unitTypeLoader: UnitTypeLoader;
}

// ─── Helpers ───

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

function parsePhaseConfigInput(raw: unknown, validPhaseNames: string[]): PhaseConfig | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('phase_config must be an object');
  const obj = raw as Record<string, unknown>;
  const result: PhaseConfig = {};
  for (const [phase, entry] of Object.entries(obj)) {
    if (!validPhaseNames.includes(phase)) throw new Error(`phase_config: invalid phase "${phase}"`);
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`phase_config.${phase} must be an object`);
    }
    const e = entry as Record<string, unknown>;
    const parsedEntry: PhaseEntryConfig = {};
    if (e['sidekick'] !== undefined) {
      if (typeof e['sidekick'] !== 'string') throw new Error(`phase_config.${phase}.sidekick must be a string`);
      parsedEntry.sidekick = e['sidekick'];
    }
    if (e['enabled'] !== undefined) {
      if (typeof e['enabled'] !== 'boolean') throw new Error(`phase_config.${phase}.enabled must be a boolean`);
      parsedEntry.enabled = e['enabled'];
    }
    result[phase] = parsedEntry;
  }
  return result;
}

function parseWorkerExecutionModeInput(raw: unknown): WorkerExecutionMode | undefined {
  if (raw === undefined) return undefined;
  if (raw !== 'tmux-pipe' && raw !== 'http-signal') {
    throw new Error('worker_execution_mode must be "tmux-pipe" or "http-signal"');
  }
  return raw;
}

/**
 * Shared translation of the untrusted-input execution gate's errors (Issue
 * #328) into HTTP responses, used by both /execute and /follow-up — both
 * routes can trigger ExecuteTaskUseCase's enforceExecutionGate(). Returns
 * true when it handled the error (caller should stop), false otherwise so
 * the caller falls through to its generic 400 handling.
 */
function replyToExecutionGateError(err: unknown, reply: { status: (code: number) => { send: (body: unknown) => unknown } }): boolean {
  if (err instanceof ExecutionGatePendingApprovalError) {
    reply.status(409).send({ error: 'execution_pending_approval', message: err.message });
    return true;
  }
  if (err instanceof ExecutionGateDeniedError) {
    reply.status(403).send({ error: 'execution_denied', message: err.message });
    return true;
  }
  return false;
}

function parseWorkerRuntimeInput(raw: unknown): WorkerRuntime | undefined {
  if (raw === undefined) return undefined;
  if (raw !== 'tui' && raw !== 'headless' && raw !== 'api') {
    throw new Error('worker_runtime must be "tui", "headless", or "api"');
  }
  return raw;
}

// ─── Plugin ───

const unitsRoutes: FastifyPluginCallback<UnitsRouteOptions> = (fastify, opts, done) => {
  const { unitRepo, taskRepo, logRepo, executeTaskUseCase, projectRepo, sidekickLoader, unitTypeLoader } = opts;

  // ── GET /api/units ──
  fastify.get('/api/units', async () => {
    return unitRepo.findAll();
  });

  // ── POST /api/units ──
  fastify.post('/api/units', async (request, reply) => {
    const {
      name,
      unit_type,
      system_prompt,
      self_review_max_attempts,
      review_subagent,
      implement_subagent,
      phase_config,
      worker_type,
      worker_model,
      worker_extra_args,
      worker_execution_mode,
      worker_runtime,
    } = request.body as Record<string, unknown>;
    if (!name) {
      return reply.status(400).send({ error: 'name required' });
    }
    try {
      const unitTypeName = (unit_type as string) ?? 'devops';
      const unitType = unitTypeLoader.get(unitTypeName);
      if (!unitType) {
        return reply.status(400).send({ error: `Unknown unit_type: "${unitTypeName}"` });
      }
      const validPhaseNames = unitType.phases.map((p) => p.name);
      const reviewSubagent = parseSubagentConfigInput(review_subagent, 'review_subagent');
      const implementSubagent = parseSubagentConfigInput(implement_subagent, 'implement_subagent');
      const phaseConfig = parsePhaseConfigInput(phase_config, validPhaseNames);
      const workerExecutionMode = parseWorkerExecutionModeInput(worker_execution_mode);
      const workerRuntimeVal = parseWorkerRuntimeInput(worker_runtime);
      const id = unitRepo.create({
        name: name as string,
        unitType: unitTypeName,
        systemPrompt: (system_prompt as string) ?? null,
        selfReviewMaxAttempts: (self_review_max_attempts as number) ?? 2,
        reviewSubagent,
        implementSubagent,
        phaseConfig,
        workerType: (worker_type as string) ?? null,
        workerModel: (worker_model as string) ?? null,
        workerExtraArgs: (worker_extra_args as string) ?? null,
        workerExecutionMode: workerExecutionMode ?? 'tmux-pipe',
        workerRuntime: workerRuntimeVal ?? 'tui',
      });
      return { ok: true, id };
    } catch (err: unknown) {
      return reply.status(500).send({ error: (err as Error).message });
    }
  });

  // ── GET /api/units/:id ──
  fastify.get<{ Params: { id: string } }>(
    '/api/units/:id',
    async (request, reply) => {
      const s = unitRepo.findById(parseInt(request.params.id, 10));
      if (!s) return reply.status(404).send({ error: 'Unit not found' });
      return s;
    },
  );

  // ── PUT /api/units/:id ──
  fastify.put<{ Params: { id: string } }>(
    '/api/units/:id',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const existing = unitRepo.findById(id);
      if (!existing) return reply.status(404).send({ error: 'Unit not found' });
      const {
        name,
        unit_type,
        system_prompt,
        self_review_max_attempts,
        review_subagent,
        implement_subagent,
        phase_config,
        worker_type,
        worker_model,
        worker_extra_args,
        worker_execution_mode,
        worker_runtime,
      } = request.body as Record<string, unknown>;
      try {
        const unitTypeName = (unit_type as string | undefined) ?? existing.unitType;
        const unitType = unitTypeLoader.get(unitTypeName);
        if (!unitType) {
          return reply.status(400).send({ error: `Unknown unit_type: "${unitTypeName}"` });
        }
        const validPhaseNames = unitType.phases.map((p) => p.name);
        const reviewSubagent = review_subagent !== undefined
          ? parseSubagentConfigInput(review_subagent, 'review_subagent')
          : existing.reviewSubagent;
        const implementSubagent = implement_subagent !== undefined
          ? parseSubagentConfigInput(implement_subagent, 'implement_subagent')
          : existing.implementSubagent;
        const phaseConfig = phase_config !== undefined
          ? parsePhaseConfigInput(phase_config, validPhaseNames)
          : existing.phaseConfig;
        const workerExecutionMode = parseWorkerExecutionModeInput(worker_execution_mode);
        const workerRuntimeVal = parseWorkerRuntimeInput(worker_runtime);
        unitRepo.update(id, {
          name: (name as string) || existing.name,
          unitType: unitTypeName,
          systemPrompt:
            system_prompt !== undefined ? (system_prompt as string) : existing.systemPrompt,
          selfReviewMaxAttempts:
            self_review_max_attempts !== undefined ? (self_review_max_attempts as number) : existing.selfReviewMaxAttempts,
          reviewSubagent,
          implementSubagent,
          phaseConfig,
          workerType: worker_type !== undefined ? (worker_type as string) : existing.workerType,
          workerModel: worker_model !== undefined ? (worker_model as string) : existing.workerModel,
          workerExtraArgs: worker_extra_args !== undefined ? (worker_extra_args as string) : existing.workerExtraArgs,
          workerExecutionMode: workerExecutionMode ?? existing.workerExecutionMode,
          workerRuntime: workerRuntimeVal ?? existing.workerRuntime,
        });
        return { ok: true };
      } catch (err: unknown) {
        return reply.status(500).send({ error: (err as Error).message });
      }
    },
  );

  // ── DELETE /api/units/:id ──
  fastify.delete<{ Params: { id: string } }>(
    '/api/units/:id',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      if (!unitRepo.findById(id))
        return reply.status(404).send({ error: 'Unit not found' });
      unitRepo.delete(id);
      return { ok: true };
    },
  );

  // ── POST /api/units/:id/execute ──
  fastify.post<{ Params: { id: string } }>(
    '/api/units/:id/execute',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      if (!unitRepo.findById(id))
        return reply.status(404).send({ error: 'Unit not found' });
      const { taskId, force } = request.body as { taskId?: number; force?: boolean };
      if (!taskId) return reply.status(400).send({ error: 'taskId required' });
      try {
        await executeTaskUseCase.execute(id, taskId, { force: force === true });
        return { ok: true };
      } catch (err: unknown) {
        if (err instanceof ResourceExhaustedError)
          return reply.status(409).send({ error: 'insufficient_resources', resources: err.status });
        if (replyToExecutionGateError(err, reply)) return;
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  // ── POST /api/units/:id/follow-up ──
  fastify.post<{ Params: { id: string } }>(
    '/api/units/:id/follow-up',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const unit = unitRepo.findById(id);
      if (!unit)
        return reply.status(404).send({ error: 'Unit not found' });
      const { taskId, comment, phaseNames } = request.body as { taskId?: number; comment?: string; phaseNames?: string[] };
      if (!taskId) return reply.status(400).send({ error: 'taskId required' });
      if (!comment || !comment.trim()) return reply.status(400).send({ error: 'comment required' });

      // Build the final message: resolved Sidekick bodies for the selected phases + user comment.
      // `phaseNames` is the primary parameter (array of phase name strings).
      let finalComment = comment.trim();

      const ut = unitTypeLoader.get(unit.unitType);
      const utPhaseNames = ut ? ut.phases.map((p) => p.name) : [];

      const phases: string[] = phaseNames
        ? phaseNames.filter((n) => utPhaseNames.includes(n))
        : [];
      if (phases.length > 0 && ut) {
        try {
          const phaseSection = phases
            .map((phase) => {
              const phaseDef = ut.phases.find((p) => p.name === phase);
              if (!phaseDef) throw new Error(`Phase "${phase}" not found in unitType "${unit.unitType}"`);
              const sidekick = resolvePhaseSidekick(sidekickLoader, phase, unit.phaseConfig, phaseDef);
              return `## Phase: ${phase}\n${sidekick.body}`;
            })
            .join('\n\n');
          finalComment = `${phaseSection}\n\n## User Instructions\n${finalComment}`;
        } catch (err: unknown) {
          return reply.status(400).send({ error: (err as Error).message });
        }
      }

      try {
        await executeTaskUseCase.followUp(id, taskId, finalComment);
        return { ok: true };
      } catch (err: unknown) {
        if (replyToExecutionGateError(err, reply)) return;
        return reply.status(400).send({ error: (err as Error).message });
      }
    },
  );

  // ── POST /api/units/:id/stop ──
  fastify.post<{ Params: { id: string } }>(
    '/api/units/:id/stop',
    async (request) => {
      const id = parseInt(request.params.id, 10);
      const { taskId } = (request.body as { taskId?: number }) || {};
      const stopped = executeTaskUseCase.stop(id, taskId);
      return { ok: true, stopped };
    },
  );

  // ── POST /api/units/:id/approve-plan ──
  fastify.post<{ Params: { id: string } }>(
    '/api/units/:id/approve-plan',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const unit = unitRepo.findById(id);
      if (!unit) return reply.status(404).send({ error: 'Unit not found' });

      const { taskId, approved, feedback } = request.body as {
        taskId?: number;
        approved?: boolean;
        feedback?: string;
      };
      if (!taskId) return reply.status(400).send({ error: 'taskId required' });
      if (approved === undefined) return reply.status(400).send({ error: 'approved required' });

      const task = taskRepo.findById(taskId);
      if (!task || task.status !== ('phase_review' as TaskStatus)) {
        return reply.status(400).send({ error: 'Task is not in phase_review state' });
      }

      if (!approved) {
        // Rejected
        if (feedback) {
          // Send feedback and restart planning via followUp
          logRepo.append(taskId, id, 'status_change', { status: 'plan_changes_requested', feedback });
          taskRepo.updateStatus(taskId, 'running');
          taskRepo.updateCurrentPhase(taskId, 'planning');
          executeTaskUseCase.followUp(id, taskId, feedback).catch(() => {});
        } else {
          // No feedback = full rejection
          logRepo.append(taskId, id, 'status_change', { status: 'plan_rejected' });
          taskRepo.updateStatus(taskId, 'failed' as TaskStatus);
        }
        return { ok: true };
      }

      // Approved - resume execution from implementing phase
      logRepo.append(taskId, id, 'status_change', { status: 'plan_approved', feedback: feedback || undefined });
      if (feedback) {
        const plan = task.planMarkdown || '';
        taskRepo.update(taskId, { planMarkdown: plan + '\n\n### 追加指示\n' + feedback } as Partial<import('../tasks/Task').Task>);
      }
      taskRepo.updateStatus(taskId, 'running');
      taskRepo.updateCurrentPhase(taskId, 'implementing');
      executeTaskUseCase.resumeStateMachine(id, taskId).catch(() => {});
      return { ok: true };
    },
  );

  // ── POST /api/units/:id/approve-execution ──
  //
  // Approves/rejects the untrusted-input execution gate (Issue #328) — a
  // separate concern from approve-plan above: that endpoint approves a
  // PLAN the worker already produced (secrets/worktree already used once);
  // this one approves letting an untrusted task run a worker AT ALL, before
  // any of that has happened yet (task.status === 'pending_approval').
  fastify.post<{ Params: { id: string } }>(
    '/api/units/:id/approve-execution',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      const unit = unitRepo.findById(id);
      if (!unit) return reply.status(404).send({ error: 'Unit not found' });

      // Runtime-validated, not just type-asserted: this endpoint flips a
      // security gate, so a truthy-but-wrong body (e.g. `approved: "false"`,
      // a string — truthy, and would have slipped past a bare `undefined`
      // check) must not be able to approve execution (Issue #328 review).
      const body = request.body as { taskId?: unknown; approved?: unknown };
      const { taskId, approved } = body;
      if (typeof taskId !== 'number' || !Number.isInteger(taskId) || taskId <= 0) {
        return reply.status(400).send({ error: 'taskId must be a positive integer' });
      }
      if (typeof approved !== 'boolean') {
        return reply.status(400).send({ error: 'approved must be a boolean' });
      }

      const task = taskRepo.findById(taskId);
      if (!task || task.status !== ('pending_approval' as TaskStatus)) {
        return reply.status(400).send({ error: 'Task is not pending execution approval' });
      }

      // The route's :id and the task's actual Unit must agree — otherwise an
      // approval submitted against the wrong Unit id would still be honored
      // (and would resume the task via `id`, not the Unit it's really
      // governed by/logged under). Same resolution ExecuteTaskUseCase uses
      // (task.unitId ?? project.defaultUnitId), so this doesn't invent a new
      // "which Unit owns this task" rule.
      const project = projectRepo.findById(task.projectId);
      const resolvedUnitId = resolveUnitId(task, project);
      if (resolvedUnitId !== id) {
        return reply.status(400).send({ error: `Task ${taskId} belongs to unit ${resolvedUnitId ?? 'none'}, not unit ${id}` });
      }

      if (!approved) {
        logRepo.append(taskId, id, 'status_change', { status: 'execution_denied' });
        taskRepo.updateStatus(taskId, 'failed' as TaskStatus);
        return { ok: true };
      }

      // Record approval against the CURRENT description (checkExecutionGate
      // re-hashes on every check) so re-running this same task later does not
      // re-prompt, but a subsequent description edit (task stays untrusted)
      // will invalidate this and require approval again.
      logRepo.append(taskId, id, 'status_change', { status: 'execution_approved' });
      taskRepo.update(taskId, { executionApprovedDescriptionHash: hashTaskDescription(task.description) } as Partial<import('../tasks/Task').Task>);

      // Which entry point to resume depends on whether this task ever
      // actually started: tmuxWindow is only ever set once execute() (or
      // TaskRestoreService.restore()) got past the gate far enough to create
      // one. The gate runs BEFORE that in every caller, so "no window yet"
      // reliably means the block happened in execute() itself — a fresh
      // start. "Window already exists" means the block happened mid-run
      // (followUp/resumeStateMachine, e.g. a description edit invalidated a
      // previously-approved, already-running task) — resuming the state
      // machine from task.currentPhase is the correct continuation there,
      // not a second execute() (which would recreate the window/worktree).
      taskRepo.updateStatus(taskId, task.tmuxWindow ? 'running' : 'open');
      if (task.tmuxWindow) {
        executeTaskUseCase.resumeStateMachine(id, taskId).catch(() => {});
      } else {
        executeTaskUseCase.execute(id, taskId).catch(() => {});
      }
      return { ok: true };
    },
  );

  // ── GET /api/units/:id/logs ──
  fastify.get<{ Params: { id: string } }>(
    '/api/units/:id/logs',
    async (request, reply) => {
      const id = parseInt(request.params.id, 10);
      if (!unitRepo.findById(id))
        return reply.status(404).send({ error: 'Unit not found' });
      return logRepo.findByUnit(id);
    },
  );

  done();
};

export default unitsRoutes;
