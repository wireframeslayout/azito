import type { ITaskRepository, Task } from '../Task';
import type { TaskStatus } from '../TaskStatus';
import type { IExecutionLogRepository } from '../ExecutionLog';
import type { ExecuteTaskUseCase } from './ExecuteTaskUseCase';
import type { IUnitRepository } from '../../units/Unit';
import type { IProjectRepository } from '../../projects/Project';
import type { IProjectServerRepository } from '../../projects/ProjectServer';
import type { IServerRepository } from '../../servers/Server';
import type { SqliteProjectSecretRepository } from '../../projects/SqliteProjectSecretRepository';
import type { IWindowRepository } from '../../windows/Window';
import type { WindowRespawnService } from '../../windows/WindowRespawnService';
import { buildRespawnManifestInput } from '../../windows/WindowRespawnService';
import type { SidekickPackageLoader } from '../../sidekicks/SidekickPackageLoader';
import type { UnitTypeLoader } from '../../sidekicks/UnitTypeLoader';
import type { TaskRestoreService } from '../TaskRestoreService';
import { resolveExecutionManifest, hashExecutionManifest } from './ExecutionManifest';
import { resolveTaskServerName } from './TaskExecutionEnv';

/**
 * The decision core of POST /api/tasks/:id/approve-execution (Issue #328),
 * factored out of the route handler so the actual approve/deny/dispatch
 * logic lives in exactly one place — see ExecutionManifest.ts's own module
 * doc comment for why a second, hand-copied implementation is worth
 * avoiding.
 *
 * There used to be a second entry point, POST /api/units/:id/approve-execution
 * (modules/units/routes.ts, Unit-scoped) — removed (Issue #328 hardening
 * follow-up) because it never required `fingerprint`, so it approved the
 * exact same gate as this route without the TOCTOU check `fingerprint`
 * exists for (fix 1 below): a live bypass of that check as long as it stayed
 * reachable. This route is task-scoped instead (a task whose Unit cannot be
 * resolved — e.g. a `restore`-pending task after its project's
 * defaultUnitId was cleared — has no Unit id to address a Unit-scoped route
 * with at all, so it could never be approved OR denied through one; a
 * permanent stuck state). It resolves `unitId` itself (nullable)
 *   and always passes `fingerprint` (Issue #328 review fix 1).
 */

export interface ExecutionApprovalDeps {
  taskRepo: ITaskRepository;
  logRepo: IExecutionLogRepository;
  unitRepo: IUnitRepository;
  projectRepo: IProjectRepository;
  projectServerRepo: IProjectServerRepository;
  serverRepo: IServerRepository;
  projectSecretRepo: SqliteProjectSecretRepository;
  unitTypeLoader: UnitTypeLoader;
  sidekickLoader: SidekickPackageLoader;
  windowRepo: IWindowRepository;
  respawnService: WindowRespawnService;
  executeTaskUseCase: ExecuteTaskUseCase;
  taskRestoreService: TaskRestoreService;
}

export interface ExecutionApprovalParams {
  taskId: number;
  /**
   * The task's resolved Unit id, or null when it cannot be resolved
   * (Issue #328 review fix 2 — e.g. the project has no defaultUnitId and the
   * task itself has none either). Operations that must actually launch a
   * worker through ExecuteTaskUseCase ('execute', 'resume') cannot dispatch
   * without one; every other operation ('restore', 'respawn',
   * 'recover_session_legacy', 'resume_await_answer',
   * 'resume_await_plan_review') does not need it to run, only to log against
   * (skipped when null, same as TaskRestoreService.restore's own
   * `if (unitId !== null)` guard around its pending_approval log entry).
   */
  unitId: number | null;
  approved: boolean;
  /**
   * The fingerprint the approver saw on the approval screen (Issue #328
   * review fix 1 — GET .../execution-approval's own `fingerprint` field,
   * computed off the SAME resolveExecutionManifest() call this function
   * re-resolves and re-hashes below). When provided, an approval is rejected
   * with 409 `fingerprint_mismatch` if it doesn't match the manifest
   * resolved AT THE MOMENT OF APPROVAL — closing the TOCTOU window between
   * "human read the manifest" and "human clicked approve" where the task,
   * Unit, Sidekick, server, or secrets could have been edited out from under
   * them. Typed optional here only because a denial never needs it (checked
   * regardless of what changed in the manifest, since a denial only ever
   * stops the run) — the route handler itself requires it whenever
   * `approved` is true (see POST /api/tasks/:id/approve-execution's own
   * validation).
   */
  fingerprint?: string;
}

export interface ExecutionApprovalOutcome {
  status: number;
  body: Record<string, unknown>;
}

interface ApprovalLogger {
  error: (obj: unknown, msg: string) => void;
  warn: (msg: string) => void;
}

export function decideExecutionApproval(
  deps: ExecutionApprovalDeps,
  params: ExecutionApprovalParams,
  log: ApprovalLogger,
): ExecutionApprovalOutcome {
  const { taskRepo, logRepo, unitRepo, projectRepo, projectServerRepo, serverRepo, projectSecretRepo, unitTypeLoader, sidekickLoader, windowRepo, respawnService, executeTaskUseCase, taskRestoreService } = deps;
  const { taskId, unitId, approved, fingerprint } = params;

  const task = taskRepo.findById(taskId);
  if (!task || task.status !== ('pending_approval' as TaskStatus)) {
    return { status: 400, body: { error: 'Task is not pending execution approval' } };
  }

  const operation = task.pendingOperation;
  if (!operation) {
    return { status: 409, body: { error: `Task ${taskId} is pending_approval but has no pendingOperation recorded — nothing to approve or deny` } };
  }
  const pendingWindowId = task.pendingOperationWindowId;
  const respawnWindow = operation === 'respawn' && pendingWindowId !== null ? windowRepo.findById(pendingWindowId) : null;
  const priorStatus = (task.pendingOperationPriorStatus ?? 'failed') as TaskStatus;

  const appendLogIfUnitKnown = (type: Parameters<IExecutionLogRepository['append']>[2], content: unknown): void => {
    if (unitId !== null) logRepo.append(taskId, unitId, type, content);
  };

  if (!approved) {
    const denyStatus = (operation === 'restore' ? 'archived' : 'failed') as TaskStatus;
    const consumed = taskRepo.consumePendingApproval(taskId, { status: denyStatus });
    if (!consumed) {
      return { status: 409, body: { error: `Task ${taskId}'s pending approval was already resolved by a concurrent request` } };
    }
    appendLogIfUnitKnown('status_change', { status: 'execution_denied' });
    return { status: 200, body: { ok: true } };
  }

  // Operations that actually launch a worker through ExecuteTaskUseCase need
  // a resolved Unit to call it with — fail fast (before consuming the
  // approval) rather than consume it and then have nothing runnable to
  // dispatch to, which would leave the task silently stuck with a cleared
  // pendingOperation but nothing executed (Issue #328 review fix 2).
  if ((operation === 'execute' || operation === 'resume') && unitId === null) {
    return {
      status: 409,
      body: { error: `Task ${taskId} has no resolvable Unit — cannot approve a "${operation}" operation without one. Assign a Unit to the task or its project, then retry.` },
    };
  }

  const { manifest } = resolveExecutionManifest(
    task,
    { unitRepo, projectRepo, projectServerRepo, serverRepo, projectSecretRepo, unitTypeLoader, sidekickLoader },
    respawnWindow ? buildRespawnManifestInput(respawnWindow) : undefined,
    respawnWindow?.serverName,
  );
  const currentHash = hashExecutionManifest(manifest);

  if (fingerprint !== undefined && fingerprint !== currentHash) {
    // Do NOT consume the approval — the task stays pending_approval so the
    // human can re-fetch the current manifest and decide again (Issue #328
    // review fix 1). Nothing here has mutated task state yet.
    return {
      status: 409,
      body: {
        error: 'The execution manifest changed since you loaded this approval — re-check the current content before approving.',
        code: 'fingerprint_mismatch',
      },
    };
  }

  const consumed = taskRepo.consumePendingApproval(taskId, { executionApprovedFingerprintHash: currentHash });
  if (!consumed) {
    return { status: 409, body: { error: `Task ${taskId}'s pending approval was already resolved by a concurrent request` } };
  }
  appendLogIfUnitKnown('status_change', { status: 'execution_approved' });

  const failApprovedOperation = (op: string, err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, taskId, operation: op }, `approved ${op} failed`);
    appendLogIfUnitKnown('command', { type: 'approved_operation_failed', operation: op, message });
    taskRepo.update(taskId, { status: 'failed' as TaskStatus } as Partial<Task>);
  };

  if (operation === 'resume_await_answer' || operation === 'resume_await_plan_review') {
    appendLogIfUnitKnown('status_change', {
      status: 'execution_approved_awaiting_resubmit',
      operation,
      restoredStatus: priorStatus,
    });
    taskRepo.updateStatus(taskId, priorStatus);
  } else if (operation === 'restore') {
    const approvedTask = taskRepo.findById(taskId);
    if (!approvedTask) {
      failApprovedOperation('restore', new Error(`Task ${taskId} disappeared after approval`));
    } else {
      taskRestoreService.restore(approvedTask, log).catch((err: unknown) => failApprovedOperation('restore', err));
    }
  } else if (operation === 'resume') {
    taskRepo.updateStatus(taskId, 'running');
    executeTaskUseCase.resumeStateMachine(unitId as number, taskId).catch((err: unknown) => failApprovedOperation('resume', err));
  } else if (operation === 'respawn') {
    const win = pendingWindowId !== null ? windowRepo.findById(pendingWindowId) : null;
    const srv = win ? serverRepo.findByName(win.serverName) : null;
    if (!win || !srv) {
      failApprovedOperation('respawn', new Error(`Window ${pendingWindowId ?? 'null'} or its server no longer exists`));
    } else {
      respawnService.respawn(win.id, srv)
        .then(() => { taskRepo.updateStatus(taskId, priorStatus); })
        .catch((err: unknown) => failApprovedOperation('respawn', err));
    }
  } else if (operation === 'recover_session_legacy') {
    const resolvedServerName = resolveTaskServerName(task, projectServerRepo);
    const srv = resolvedServerName ? serverRepo.findByName(resolvedServerName) : null;
    if (!srv) {
      failApprovedOperation('recover_session_legacy', new Error(`Server '${resolvedServerName ?? 'unresolved'}' not found`));
    } else {
      respawnService.resumeLegacySession(taskId, srv)
        .then(() => { taskRepo.updateStatus(taskId, priorStatus); })
        .catch((err: unknown) => failApprovedOperation('recover_session_legacy', err));
    }
  } else {
    taskRepo.updateStatus(taskId, 'open');
    executeTaskUseCase.execute(unitId as number, taskId).catch((err: unknown) => failApprovedOperation('execute', err));
  }

  return { status: 200, body: { ok: true } };
}
