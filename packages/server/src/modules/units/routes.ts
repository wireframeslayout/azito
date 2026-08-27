import type { FastifyPluginCallback } from 'fastify';
import type { IUnitRepository, SubagentConfig, WorkerExecutionMode, WorkerRuntime } from './Unit';
import type { ITaskRepository, Task } from '../tasks/Task';
import type { TaskStatus } from '../tasks/TaskStatus';
import type { IExecutionLogRepository } from '../tasks/ExecutionLog';
import type { ExecuteTaskUseCase } from '../tasks/execution/ExecuteTaskUseCase';
import type { IProjectRepository } from '../projects/Project';
import type { IProjectServerRepository } from '../projects/ProjectServer';
import type { IServerRepository } from '../servers/Server';
import type { SidekickPackageLoader } from '../sidekicks/SidekickPackageLoader';
import type { PhaseConfig, PhaseEntryConfig } from '../sidekicks/PhaseConfig';
import type { UnitTypeLoader } from '../sidekicks/UnitTypeLoader';
import { resolvePhaseSidekick } from '../sidekicks/resolvePhaseSidekick';
import { ResourceExhaustedError } from '../servers/resources/ResourceGuard';
import { replyToExecutionGateError } from '../tasks/execution/ExecutionGate';
import { resolveTaskServerName } from '../tasks/execution/TaskExecutionEnv';
import { failAsyncTaskOperation } from '../tasks/execution/AppendLog';

// ─── Types ───

export interface UnitsRouteOptions {
  unitRepo: IUnitRepository;
  taskRepo: ITaskRepository;
  logRepo: IExecutionLogRepository;
  executeTaskUseCase: ExecuteTaskUseCase;
  projectRepo: IProjectRepository;
  projectServerRepo: IProjectServerRepository;
  serverRepo: IServerRepository;
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

function parseWorkerRuntimeInput(raw: unknown): WorkerRuntime | undefined {
  if (raw === undefined) return undefined;
  if (raw !== 'tui' && raw !== 'headless' && raw !== 'api') {
    throw new Error('worker_runtime must be "tui", "headless", or "api"');
  }
  return raw;
}

// ─── Plugin ───

const unitsRoutes: FastifyPluginCallback<UnitsRouteOptions> = (fastify, opts, done) => {
  const { unitRepo, taskRepo, logRepo, executeTaskUseCase, projectRepo, projectServerRepo, serverRepo, sidekickLoader, unitTypeLoader } = opts;

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
      sleep_after_push,
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
        sleepAfterPush: !!sleep_after_push,
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
        sleep_after_push,
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
          sleepAfterPush: sleep_after_push !== undefined ? !!sleep_after_push : existing.sleepAfterPush,
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

      // Both branches below that actually resume a worker (feedback-driven
      // followUp / approved resumeStateMachine) need the resolved server for
      // the untrusted-input execution gate (Issue #328) — resolved once here
      // and gate-checked synchronously in each branch, BEFORE either mutates
      // task.status/currentPhase or persists `feedback`. Previously those
      // mutations ran first and the resume call was fire-and-forget with
      // `.catch(() => {})`: a gate block silently discarded `feedback` (never
      // persisted anywhere else) while leaving the task stuck in a status
      // ('running'/'planning' or 'running'/'implementing') that no longer
      // matched what actually happened (sixth-round review finding 1, same
      // failure mode as /api/tasks/:id/answer).
      //
      // Gate checks below pass 'resume_await_plan_review', NOT plain
      // 'resume' (seventh-round review symptom A): `feedback` is not
      // persisted anywhere until AFTER the gate check passes, so a block here
      // must not auto-resume via resumeStateMachine() on approval — that
      // would restart the task without ever delivering the feedback the
      // human just typed. The approval handler (approve-execution below)
      // instead restores task.status to 'phase_review' and leaves it for the
      // human to resubmit this same approve-plan call. See the transition
      // table on Task.pendingOperation.
      const resolvedServerName = resolveTaskServerName(task, projectServerRepo);
      const server = resolvedServerName ? serverRepo.findByName(resolvedServerName) : null;
      if (!server) return reply.status(404).send({ error: 'Server not found' });

      // Delegates to failAsyncTaskOperation() (tasks/execution/AppendLog.ts)
      // — the same shared helper approve-execution's failApprovedOperation
      // and POST /api/tasks/:id/answer's follow-up catch use, so this
      // failure ALSO emits on the shared events EventEmitter (not just
      // logRepo.append()), and therefore reaches other connected clients as
      // a `task:status` WS event / push notification instead of leaving
      // them stuck showing `phase_review` forever.
      const failResumedOperation = (op: string, err: unknown): void => {
        failAsyncTaskOperation({ taskRepo, logRepo, events: executeTaskUseCase.events, log: request.log }, taskId, id, op, err, `approve-plan ${op} failed`);
      };

      if (!approved) {
        // Rejected
        if (feedback) {
          // Send feedback and restart planning via followUp
          try {
            executeTaskUseCase.enforceExecutionGate(task, id, 'resume_await_plan_review');
          } catch (err) {
            if (replyToExecutionGateError(err, reply)) return;
            throw err;
          }
          logRepo.append(taskId, id, 'status_change', { status: 'plan_changes_requested', feedback });
          taskRepo.updateStatus(taskId, 'running');
          taskRepo.updateCurrentPhase(taskId, 'planning');
          executeTaskUseCase.followUp(id, taskId, feedback).catch((err: unknown) => failResumedOperation('follow-up', err));
        } else {
          // No feedback = full rejection — no worker is resumed, so no gate check needed.
          logRepo.append(taskId, id, 'status_change', { status: 'plan_rejected' });
          taskRepo.updateStatus(taskId, 'failed' as TaskStatus);
        }
        return { ok: true };
      }

      // Approved - resume execution from implementing phase. Same
      // 'resume_await_plan_review' operation as the rejected-with-feedback
      // branch above: an approved-with-feedback plan appends `feedback` to
      // planMarkdown only AFTER this gate check passes (below), so a block
      // here must not auto-resume either — see the comment above this
      // handler and the transition table on Task.pendingOperation.
      try {
        executeTaskUseCase.enforceExecutionGate(task, id, 'resume_await_plan_review');
      } catch (err) {
        if (replyToExecutionGateError(err, reply)) return;
        throw err;
      }
      logRepo.append(taskId, id, 'status_change', { status: 'plan_approved', feedback: feedback || undefined });
      if (feedback) {
        const plan = task.planMarkdown || '';
        taskRepo.update(taskId, { planMarkdown: plan + '\n\n### 追加指示\n' + feedback } as Partial<import('../tasks/Task').Task>);
      }
      taskRepo.updateStatus(taskId, 'running');
      taskRepo.updateCurrentPhase(taskId, 'implementing');
      executeTaskUseCase.resumeStateMachine(id, taskId).catch((err: unknown) => failResumedOperation('resume', err));
      return { ok: true };
    },
  );

  // POST /api/units/:id/approve-execution was removed (Issue #328 hardening
  // follow-up): it approved the SAME untrusted-input execution gate as
  // POST /api/tasks/:id/approve-execution (modules/tasks/routes.ts,
  // decideExecutionApproval()) but never required the `fingerprint` the
  // TOCTOU close (Issue #328 review fix 1) depends on — a second reachable
  // path to the same approval that skipped the one check fix 1 exists for.
  // Approval is task-scoped (matches the design: a human approves running
  // a specific TASK, not a Unit) and now has exactly one entry point.

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
