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
import { resolveExecutionManifest, hashExecutionManifest, type ExecutionManifestResolution } from './ExecutionManifest';
import { resolveTaskServerName } from './TaskExecutionEnv';
import { appendLogAndEmit, failAsyncTaskOperation } from './AppendLog';
import type { AuditLogService } from '../../../shared/audit/AuditLogService';
import { recordAuditBestEffort } from '../../../shared/audit/recordAuditBestEffort';
import type { Principal } from '../../../shared/auth/Principal';
import { OPERATOR_PRINCIPAL } from '../../../shared/auth/Principal';

/**
 * Dependencies needed to resolve the manifest for a `pending_approval` task
 * — a subset of {@link ExecutionApprovalDeps} plus `windowRepo` (needed only
 * to look up the respawn window; see {@link resolvePendingApprovalManifest}).
 */
export interface PendingApprovalManifestDeps {
  unitRepo: IUnitRepository;
  projectRepo: IProjectRepository;
  projectServerRepo: IProjectServerRepository;
  serverRepo: IServerRepository;
  projectSecretRepo: SqliteProjectSecretRepository;
  unitTypeLoader: UnitTypeLoader;
  sidekickLoader: SidekickPackageLoader;
  windowRepo: IWindowRepository;
}

/**
 * Resolves the execution manifest for a `pending_approval` task — the ONE
 * place both GET /api/tasks/:id/execution-approval (display + fingerprint
 * the human sees) and decideExecutionApproval (fingerprint re-check at the
 * moment of approval) must call, so the two can never resolve a different
 * manifest for the same task (Issue #328 fourteenth-round review).
 *
 * Before this function existed, GET always called resolveExecutionManifest()
 * with no overrides, while decideExecutionApproval separately looked up the
 * respawn window and passed `buildRespawnManifestInput(window)` +
 * `window.serverName` whenever `pendingOperation === 'respawn'`. Those two
 * inputs produce different manifests (respawn's `respawn` field is null vs.
 * populated, and the `server`/branches fields can resolve to a different
 * server entirely — see resolveExecutionManifest's `serverNameOverride` doc
 * comment) — so the fingerprint GET displayed could never match the one POST
 * re-hashed for a respawn-blocked task, and approval was permanently stuck
 * at `fingerprint_mismatch`.
 *
 * `pendingOperation` is read directly off `task` (not passed separately) —
 * both call sites already have the up-to-date task row before calling this.
 *
 * Throws (does not fall back to the non-respawn manifest) when
 * `pendingOperation === 'respawn'` but the recorded window
 * (`task.pendingOperationWindowId`) no longer exists — silently falling
 * back would resolve the SAME wrong manifest this function exists to avoid,
 * just via a different code path. Callers must not swallow this into an
 * approved/executed outcome; both call sites here surface it as an error
 * response instead.
 */
export function resolvePendingApprovalManifest(
  task: Task,
  deps: PendingApprovalManifestDeps,
): ExecutionManifestResolution {
  // operationKind: derived from `task.pendingOperation` itself — the gate
  // that blocked this task already recorded WHICH entry point it was (see
  // Task.pendingOperation's doc comment). `null` also maps to 'execute'
  // (not 'continuation'): this function is also called for the
  // creation-time pre-approvable case (GET's `isPreApprovable`, mirroring
  // decideExecutionPreApproval's own eligibility check) — status 'open'
  // with pendingOperation still null, i.e. strictly BEFORE the task's
  // first execute() has ever run, so the current project-server
  // configuration is exactly what that first execute() is about to
  // distribute from. Every OTHER blocked operation
  // ('resume'/'resume_await_answer'/'resume_await_plan_review'/'restore'/
  // 'respawn'/'recover_session_legacy') resumes a task whose working
  // directory a past execute()/restore() already populated. See
  // resolveExecutionManifest's own doc comment for the full rationale
  // (Issue #87 review, forge/87-mirror follow-up, Important finding).
  const operationKind = task.pendingOperation === 'execute' || task.pendingOperation === null ? 'execute' : 'continuation';
  if (task.pendingOperation === 'respawn') {
    const windowId = task.pendingOperationWindowId;
    const win = windowId !== null ? deps.windowRepo.findById(windowId) : null;
    if (!win) {
      throw new Error(
        `Task ${task.id} is pending_approval for a "respawn" operation but its recorded window (id ${windowId ?? 'null'}) no longer exists — cannot resolve the manifest a respawn would actually use.`,
      );
    }
    return resolveExecutionManifest(task, deps, operationKind, buildRespawnManifestInput(win), win.serverName);
  }
  return resolveExecutionManifest(task, deps, operationKind);
}

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

/**
 * Client-reported origin of an approval decision (task/328-input-trust-and-
 * exec-gate follow-up, part B) — audit-only, carried on the
 * 'execution_approved'/'execution_pre_approved' log entries so a human
 * reviewing the audit trail can tell "approved via the interactive
 * create-form's own review" apart from "approved via the pending_approval
 * panel". An enum, not a free string (never pass an arbitrary
 * client-supplied string into the log — see the route handler's own
 * validation): a caller cannot invent a new, unaudited-for origin value.
 *
 * Deliberately NEVER read by any approve/deny DECISION in this file — only
 * by the log line that records what already happened. Trusting a
 * client-supplied field for authorization would let any caller claim
 * 'creation_form' to dodge scrutiny; the actual gate that decides whether an
 * approval is valid is the fingerprint comparison (`hashExecutionManifest`
 * match) below, independent of this field entirely.
 *
 * 'mission_prompt' (task/328 azt-mission integration): the `/azt-mission`
 * orchestrator submits this after presenting a task's untrusted body and
 * execution context (server/Unit/working directory/branch/phases/PR
 * destination/secret names) to a human and getting an explicit approve
 * response — same audit-only treatment as the other two values, never a
 * decision input.
 */
export type ApprovalOrigin = 'creation_form' | 'approval_panel' | 'mission_prompt';

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
  /**
   * Issue #28 Phase E follow-up (third-party review, D-track "gap"
   * finding): the audit UI's own description promises an "approved"/
   * "denied" event lands in `audit_log` for every execution-approval
   * decision, but this file only ever wrote to `execution_log`
   * (`appendLogIfUnitKnown`, below) — a task-log-scoped, per-task view, not
   * the security audit trail `audit_log` is (see AuditLogService's own doc
   * comment: dedup'd, cross-task, meant for an operator reviewing WHO
   * approved/denied WHAT). Both are kept: `execution_log`'s
   * 'execution_approved' entry (and the 'execution_denied'-reason
   * status_change denyPendingApproval writes) still drives the task's own
   * timeline/WS notifications; `audit_log`'s 'execution.approved'/
   * 'execution.denied' rows are for the separate cross-task audit view and
   * carry the deciding principal, which execution_log's entries do not.
   */
  auditLog: AuditLogService;
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
  /** See {@link ApprovalOrigin} — audit-only, defaults to 'approval_panel' when omitted (every caller before this field existed WAS the approval panel). */
  origin?: ApprovalOrigin;
  /**
   * The principal that made this decision — audit-only, recorded onto the
   * `audit_log` 'execution.approved'/'execution.denied' row (see
   * {@link ExecutionApprovalDeps.auditLog}'s doc comment), never a decision
   * input (same treatment as `origin`, above). Defaults to
   * `OPERATOR_PRINCIPAL` when omitted — this route currently declares no
   * `config.auth`, so it is operator-only in practice, but callers pass
   * `request.principal` explicitly rather than relying on the default so the
   * audit row is never silently wrong if that ever changes.
   */
  actor?: Principal;
}

export interface ExecutionApprovalOutcome {
  status: number;
  body: Record<string, unknown>;
}

interface ApprovalLogger {
  error: (obj: unknown, msg: string) => void;
  warn: (msg: string) => void;
}

/**
 * The status a task moves to the INSTANT an approval is consumed — folded
 * into the same atomic `consumePendingApproval()` UPDATE that clears
 * pendingOperation (Issue #328 review round, fix 2 — see the call site's own
 * doc comment for the crash-window bug this closes). Mirrors, verbatim,
 * where each operation ALREADY left the task once its (formerly separate,
 * formerly sometimes-async) status transition landed — this function does
 * not invent a new status for any operation, only moves WHEN the existing one
 * is written:
 * - 'execute' -> 'open': unchanged from the synchronous `taskRepo.
 *   updateStatus(taskId, 'open')` this operation already ran immediately
 *   before dispatching, before this fix.
 * - 'resume' -> 'running': same reasoning; 'running' is also a
 *   RECOVERABLE_STATUSES value (RecoverStuckTasksUseCase), so a crash right
 *   after this lands is already covered by ordinary startup recovery.
 * - 'resume_await_answer' / 'resume_await_plan_review' -> `priorStatus`:
 *   unchanged from the synchronous `taskRepo.updateStatus(taskId,
 *   priorStatus)` these operations already ran (no async dispatch follows
 *   either one — the human must resubmit their answer/feedback).
 * - 'restore' -> `priorStatus` (always 'archived' — see Task.ts's
 *   pendingOperation doc comment's per-operation table): NOT a
 *   RECOVERABLE_STATUSES value, so a crash mid-restore()-dispatch still needs
 *   a human to re-trigger it — but "archived, with a plain Restore button
 *   already in the UI, fingerprint already recorded so re-approval isn't
 *   required" is a world apart from the pre-fix "pending_approval forever,
 *   approval literally impossible because pendingOperation is already NULL"
 *   dead end. Automatically re-triggering restore() at startup for any
 *   archived task with a matching fingerprint was considered and rejected:
 *   that signal is NOT unique to a crashed dispatch — an ordinary task that
 *   was approved, ran to completion, and was later archived by a human
 *   normally keeps the SAME matching fingerprint forever (nothing clears it
 *   on ordinary archival), so that heuristic would silently resurrect
 *   completed, intentionally-archived tasks on every hub restart.
 * - 'respawn' / 'recover_session_legacy' -> `priorStatus`: usually 'running'
 *   in practice (both exist only because a running task's tmux window died),
 *   which — like 'resume' above — is a RECOVERABLE_STATUSES value: a crash
 *   before the window is actually recreated is caught by ordinary startup
 *   recovery's pane-liveness check (resolvePaneId fails -> the same
 *   already-shipped "recover session" UX a dead pane gets outside this gate
 *   entirely, not a new stuck state introduced by this fix).
 */
function resolveApprovedStatus(operation: NonNullable<Task['pendingOperation']>, priorStatus: TaskStatus): TaskStatus {
  if (operation === 'execute') return 'open' as TaskStatus;
  if (operation === 'resume') return 'running' as TaskStatus;
  return priorStatus;
}

/**
 * Consumes a task's outstanding `pending_approval` gate as a DENIAL — the
 * same atomic `consumePendingApproval()` + audit log path
 * `decideExecutionApproval({ approved: false })` below applies, factored out
 * so a second caller (POST /api/tasks/:id/archive, Issue #328 fix 2) can
 * reuse it verbatim instead of hand-rolling a second denial path.
 *
 * `targetStatus`, when given, overrides the status the task lands at
 * (`decideExecutionApproval`'s own denial defaults to `'archived'` for a
 * `restore` operation and `'failed'` for everything else — see that
 * function's inline comment on `denyStatus`). The archive route always wants
 * `'archived'` regardless of which operation was pending: archiving a task
 * mid-approval is the human saying "I don't want this to run AND I don't
 * want the task to sit anywhere but archived" — one atomic denial+archive,
 * not a denial that leaves the task at 'failed' followed by a second
 * archive of that 'failed' row.
 *
 * Returns `consumed: false` (no state mutated) when the approval was already
 * resolved by a concurrent request — same race the direct call site below
 * already handles, surfaced here so the archive route can 409 the same way.
 */
export function denyPendingApproval(
  deps: Pick<ExecutionApprovalDeps, 'taskRepo' | 'logRepo' | 'executeTaskUseCase' | 'auditLog'>,
  task: Task,
  unitId: number | null,
  targetStatus?: TaskStatus,
  actor: Principal = OPERATOR_PRINCIPAL,
): { consumed: boolean; status: TaskStatus } {
  const { taskRepo, logRepo, executeTaskUseCase, auditLog } = deps;
  const operation = task.pendingOperation as NonNullable<Task['pendingOperation']>;
  const denyStatus = targetStatus ?? ((operation === 'restore' ? 'archived' : 'failed') as TaskStatus);
  const consumed = taskRepo.consumePendingApproval(task.id, { status: denyStatus });
  if (!consumed) {
    return { consumed: false, status: denyStatus };
  }
  // `status` is denyStatus — the REAL value consumePendingApproval() just
  // committed above — not a synthetic label (Issue #328 review round fix
  // 3): buildServer.ts's NotificationBus/push bridges forward
  // entry.content.status verbatim as the WS `task:status` payload's
  // `status` field, so a synthetic value like 'execution_denied' would
  // reach a client as if it were the task's actual status. The audit
  // context (that this was a denial, not just any transition to
  // denyStatus) lives in `reason`, a field those bridges don't read.
  if (unitId !== null) {
    appendLogAndEmit(logRepo, executeTaskUseCase.events, task.id, unitId, 'status_change', { status: denyStatus, reason: 'execution_denied' });
  }
  // Best-effort (see recordAuditBestEffort's doc comment) — a write failure
  // here must never turn an already-committed denial into an error
  // response; the denial itself (consumed=true above) already landed.
  recordAuditBestEffort(
    auditLog,
    {
      actorClass: actor.class,
      actorId: actor.id ?? null,
      event: 'execution.denied',
      detail: { taskId: task.id, operation, targetStatus: denyStatus },
    },
    (err) => console.error(`[ExecutionApprovalDecision] audit log write failed for task ${task.id} denial (denial still applied):`, err),
  );
  return { consumed: true, status: denyStatus };
}

export function decideExecutionApproval(
  deps: ExecutionApprovalDeps,
  params: ExecutionApprovalParams,
  log: ApprovalLogger,
): ExecutionApprovalOutcome {
  const { taskRepo, logRepo, unitRepo, projectRepo, projectServerRepo, serverRepo, projectSecretRepo, unitTypeLoader, sidekickLoader, windowRepo, respawnService, executeTaskUseCase, taskRestoreService, auditLog } = deps;
  const { taskId, unitId, approved, fingerprint, origin, actor = OPERATOR_PRINCIPAL } = params;

  const task = taskRepo.findById(taskId);
  if (!task || task.status !== ('pending_approval' as TaskStatus)) {
    return { status: 400, body: { error: 'Task is not pending execution approval' } };
  }

  const operation = task.pendingOperation;
  if (!operation) {
    return { status: 409, body: { error: `Task ${taskId} is pending_approval but has no pendingOperation recorded — nothing to approve or deny` } };
  }
  const pendingWindowId = task.pendingOperationWindowId;
  const priorStatus = (task.pendingOperationPriorStatus ?? 'failed') as TaskStatus;

  // appendLogAndEmit (not a raw logRepo.append), same as ExecuteTaskUseCase/
  // TaskRestoreService/WindowRespawnService (Issue #328 review round) — a
  // raw logRepo.append() only persists a row; nothing reads that table to
  // drive a live notification (see AppendLog.ts's own doc comment). Before
  // this fix, every log entry decideExecutionApproval wrote (including
  // 'execution_approved'/'execution_denied' and, most importantly, the
  // 'failed' transition failApprovedOperation() applies when an approved
  // dispatch throws asynchronously) went straight to logRepo, so no other
  // connected client ever saw a `task:status` WS event for any of them.
  // `executeTaskUseCase.events` is the SAME shared EventEmitter instance
  // ExecuteTaskUseCase/PhaseLoopRunner/TaskRestoreService/WindowRespawnService
  // already emit on (see ExecuteTaskUseCase's constructor doc comment) —
  // reused here rather than adding a second dependency for the same emitter.
  const appendLogIfUnitKnown = (type: Parameters<IExecutionLogRepository['append']>[2], content: unknown): void => {
    if (unitId !== null) appendLogAndEmit(logRepo, executeTaskUseCase.events, taskId, unitId, type, content);
  };

  if (!approved) {
    const outcome = denyPendingApproval({ taskRepo, logRepo, executeTaskUseCase, auditLog }, task, unitId, undefined, actor);
    if (!outcome.consumed) {
      return { status: 409, body: { error: `Task ${taskId}'s pending approval was already resolved by a concurrent request` } };
    }
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

  let manifest: ExecutionManifestResolution['manifest'];
  try {
    ({ manifest } = resolvePendingApprovalManifest(task, {
      unitRepo, projectRepo, projectServerRepo, serverRepo, projectSecretRepo, unitTypeLoader, sidekickLoader, windowRepo,
    }));
  } catch (err) {
    // Do NOT consume the approval — same reasoning as the fingerprint
    // mismatch below: nothing here has mutated task state yet, so the task
    // stays pending_approval for a human to investigate (e.g. re-trigger the
    // respawn from scratch) rather than being silently marked failed.
    const message = err instanceof Error ? err.message : String(err);
    return { status: 409, body: { error: message, code: 'pending_operation_window_missing' } };
  }
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

  // The status this task moves to the INSTANT approval is consumed (Issue
  // #328 review round, fix 2) — folded into the SAME atomic
  // consumePendingApproval() UPDATE below, alongside the fingerprint and the
  // pendingOperation-clearing that update already does. Before this fix,
  // that UPDATE cleared pendingOperation/pendingOperationWindowId/
  // pendingOperationPriorStatus while leaving `status` at 'pending_approval'
  // (COALESCE(null, status) is a no-op), and the REAL transition only landed
  // later — synchronously for 'resume'/'execute' (a negligible gap), but only
  // from an ASYNC success/failure callback for 'restore'/'respawn'/
  // 'recover_session_legacy'. A crash (process kill, unhandled rejection
  // elsewhere, log-write failure) inside that gap left the row stuck at
  // status='pending_approval' with pendingOperation=null: the UI still shows
  // "needs approval", but nothing is left to approve (decideExecutionApproval
  // itself now 409s with "no pendingOperation recorded" — see the guard at
  // the top of this function), and no record of which operation/window/prior
  // status to resume with survives. Computing `nextStatus` here and passing
  // it into the same UPDATE that clears pendingOperation makes that window
  // zero-width: pendingOperation can never be NULL while status is still
  // 'pending_approval'. See resolveApprovedStatus()'s own doc comment for
  // where each operation lands and why every landing status is one an
  // existing, ordinary code path already knows how to recover from (this
  // repo's startup recovery for 'running'/'in_progress', or a plain manual
  // re-trigger for 'open'/'archived' — no new recoverable state was invented
  // for this fix, see that function's doc comment for the per-operation
  // reasoning).
  const nextStatus = resolveApprovedStatus(operation, priorStatus);
  const consumed = taskRepo.consumePendingApproval(taskId, { executionApprovedFingerprintHash: currentHash, status: nextStatus });
  if (!consumed) {
    return { status: 409, body: { error: `Task ${taskId}'s pending approval was already resolved by a concurrent request` } };
  }
  // Audit-only entry (Issue #328 review round fix 3): 'execution_approved' is
  // not a real task.status value — it's a marker that the REAL transition
  // (`nextStatus` above, already committed by the atomic UPDATE this line
  // follows) just landed. Every operation branch below still emits its OWN
  // 'status_change' for that landed transition (synchronously for
  // resume_await_answer/resume_await_plan_review — which also carries an
  // `awaitingResubmit` flag the other operations don't — or from the async
  // operation's success callback otherwise, once it reaches a FURTHER real
  // status beyond `nextStatus`, e.g. restore()'s 'open'). Logged as 'command'
  // so the approval is still visible in the execution log without pretending
  // to be a status transition of its own (buildServer.ts's NotificationBus/
  // push bridges only react to 'status_change' entries, forwarding
  // entry.content.status verbatim as the WS `task:status` payload).
  appendLogIfUnitKnown('command', { type: 'execution_approved', origin: origin ?? 'approval_panel' });
  // Best-effort `audit_log` row (see ExecutionApprovalDeps.auditLog's doc
  // comment) — distinct from the execution_log 'command' entry just above,
  // which drives the task's own timeline/WS notifications, not the
  // cross-task audit view. A write failure here must never turn an
  // already-committed approval into an error response.
  recordAuditBestEffort(
    auditLog,
    {
      actorClass: actor.class,
      actorId: actor.id ?? null,
      event: 'execution.approved',
      detail: { taskId, operation, unitId, origin: origin ?? 'approval_panel' },
    },
    (err) => log.error({ err, taskId }, 'audit log write failed for execution approval (approval still applied)'),
  );

  // Re-fetches the task and emits its CURRENT (real) status as a
  // 'status_change' entry — used by every async operation's success
  // callback below (Issue #328 review round fix 3) instead of each guessing
  // the post-transition status by hand. restore()/respawn()/
  // resumeLegacySession() each already commit the real status themselves
  // before their promise resolves, so re-reading here is guaranteed to see
  // the committed value, not a stale in-memory copy.
  const emitCurrentStatus = (op: string): void => {
    const current = taskRepo.findById(taskId);
    if (current) appendLogIfUnitKnown('status_change', { status: current.status, operation: op });
  };

  // Delegates to the shared failAsyncTaskOperation() (AppendLog.ts) — the
  // same "mark the task failed, log + emit both a 'command' and a
  // 'status_change' entry" sequence POST /api/tasks/:id/answer's follow-up
  // catch and POST /api/units/:id/approve-plan's failResumedOperation also
  // need, now written once instead of three times (Issue #328 review round).
  const failApprovedOperation = (op: string, err: unknown): void => {
    failAsyncTaskOperation({ taskRepo, logRepo, events: executeTaskUseCase.events, log }, taskId, unitId, op, err, `approved ${op} failed`);
  };

  if (operation === 'resume_await_answer' || operation === 'resume_await_plan_review') {
    // The real transition to `priorStatus` already landed atomically inside
    // consumePendingApproval() above (nextStatus === priorStatus for this
    // operation — see resolveApprovedStatus()) — no separate updateStatus()
    // call needed here anymore (Issue #328 review round fix 2). Only the
    // notification remains to send, carrying the `awaitingResubmit` flag the
    // other operations don't (the human must resubmit the same answer/
    // feedback; nothing here auto-resumes).
    appendLogIfUnitKnown('status_change', {
      status: priorStatus,
      operation,
      awaitingResubmit: true,
    });
  } else if (operation === 'restore') {
    // status is already `priorStatus` ('archived' — see
    // resolveApprovedStatus()) by the time this reads the row back, same as
    // it always was before an approval-gated restore (Issue #328 review round
    // fix 2): TaskRestoreService.restore() only ever operates on an archived
    // task, atomic-or-not, so this is not a new state for it to tolerate.
    const approvedTask = taskRepo.findById(taskId);
    if (!approvedTask) {
      failApprovedOperation('restore', new Error(`Task ${taskId} disappeared after approval`));
    } else {
      taskRestoreService.restore(approvedTask, log)
        .then(() => emitCurrentStatus('restore'))
        .catch((err: unknown) => failApprovedOperation('restore', err));
    }
  } else if (operation === 'resume') {
    // status is already 'running' (see resolveApprovedStatus()) — this is
    // also the status RecoverStuckTasksUseCase's RECOVERABLE_STATUSES already
    // watches for, so a crash between here and resumeStateMachine() actually
    // starting is picked up by ordinary startup recovery, unchanged from
    // before this fix (Issue #328 review round fix 2 only moved WHEN this
    // status lands — earlier, into the same atomic UPDATE — not what it is).
    executeTaskUseCase.resumeStateMachine(unitId as number, taskId).catch((err: unknown) => failApprovedOperation('resume', err));
  } else if (operation === 'respawn') {
    // status is already `priorStatus` (Issue #328 review round fix 2) — most
    // often 'running' (a respawn exists because a running task's window
    // died), which is also a RECOVERABLE_STATUSES value: a crash before
    // respawn() finishes recreating the window is now caught by ordinary
    // startup recovery (pane-dead detection -> the existing "recover session"
    // UX), not left unrecoverable at 'pending_approval'.
    const win = pendingWindowId !== null ? windowRepo.findById(pendingWindowId) : null;
    const srv = win ? serverRepo.findByName(win.serverName) : null;
    if (!win || !srv) {
      failApprovedOperation('respawn', new Error(`Window ${pendingWindowId ?? 'null'} or its server no longer exists`));
    } else {
      respawnService.respawn(win.id, srv)
        .then(() => {
          // Success-callback emit (Issue #328 review round fix 3): before
          // this fix, respawn's real transition back to priorStatus was
          // applied but NEVER emitted as a 'status_change' — a client had no
          // way to learn the block had resolved short of a manual refresh.
          // No updateStatus() call needed here anymore — see above.
          emitCurrentStatus('respawn');
        })
        .catch((err: unknown) => failApprovedOperation('respawn', err));
    }
  } else if (operation === 'recover_session_legacy') {
    // Same reasoning as 'respawn' above — status is already `priorStatus`.
    const resolvedServerName = resolveTaskServerName(task, projectServerRepo);
    const srv = resolvedServerName ? serverRepo.findByName(resolvedServerName) : null;
    if (!srv) {
      failApprovedOperation('recover_session_legacy', new Error(`Server '${resolvedServerName ?? 'unresolved'}' not found`));
    } else {
      respawnService.resumeLegacySession(taskId, srv)
        .then(() => {
          // Same missing-emit fix as 'respawn' above; no updateStatus() call
          // needed here anymore either.
          emitCurrentStatus('recover_session_legacy');
        })
        .catch((err: unknown) => failApprovedOperation('recover_session_legacy', err));
    }
  } else {
    // status is already 'open' (see resolveApprovedStatus()) — same
    // "sits at a normal, human-actionable status" property this operation
    // already had before this fix (Issue #328 review round fix 2 only closed
    // the crash window BEFORE this point, which used to leave the row at
    // 'pending_approval' with no pendingOperation instead).
    executeTaskUseCase.execute(unitId as number, taskId).catch((err: unknown) => failApprovedOperation('execute', err));
  }

  return { status: 200, body: { ok: true } };
}

/**
 * Dependencies for {@link decideExecutionPreApproval} — a subset of
 * {@link ExecutionApprovalDeps}: no `windowRepo`/`respawnService`/
 * `executeTaskUseCase.execute`/`taskRestoreService` because pre-approval
 * never dispatches an operation (see that function's own doc comment), only
 * `executeTaskUseCase.events` (to emit the audit log entry the same way
 * every other write in this file does).
 */
export interface ExecutionPreApprovalDeps {
  taskRepo: ITaskRepository;
  logRepo: IExecutionLogRepository;
  unitRepo: IUnitRepository;
  projectRepo: IProjectRepository;
  projectServerRepo: IProjectServerRepository;
  serverRepo: IServerRepository;
  projectSecretRepo: SqliteProjectSecretRepository;
  unitTypeLoader: UnitTypeLoader;
  sidekickLoader: SidekickPackageLoader;
  events: ExecuteTaskUseCase['events'];
}

export interface ExecutionPreApprovalParams {
  taskId: number;
  /** Same nullable-Unit tolerance as {@link ExecutionApprovalParams.unitId} — used only to address the audit log entry, never to gate the decision. */
  unitId: number | null;
  fingerprint: string;
  origin: ApprovalOrigin;
}

/**
 * Creation-time pre-approval (task/328-input-trust-and-exec-gate follow-up,
 * part A-2) — lets the interactive task-creation form, which already showed
 * a human the untrusted content and the execution context BEFORE the task
 * was created, record that review as an execution-gate approval immediately,
 * instead of making the same human approve a second time on the
 * pending_approval panel the moment they later click "execute".
 *
 * Deliberately NOT a variant of {@link decideExecutionApproval}: that
 * function's whole shape is "consume an outstanding `pendingOperation` block
 * and dispatch whatever it was blocking" — every one of its operation
 * branches ends by either dispatching a real action (execute/resume/restore/
 * respawn/recover_session_legacy) or restoring a prior waiting status.
 * Pre-approval has no blocked operation to resume (the task was NEVER
 * gate-blocked — it is still sitting at plain 'open', exactly as
 * `POST /api/tasks` left it) and must NOT dispatch anything: the whole point
 * is that the human still triggers execution themselves, later, whenever
 * they choose — this call only pre-populates
 * `executionApprovedFingerprintHash` so THAT later `execute` call satisfies
 * `checkExecutionGate` on the first try instead of blocking. Reusing
 * `decideExecutionApproval` for this would mean inventing an eighth
 * `pendingOperation` value whose "approve" branch dispatches nothing — a
 * bigger, riskier change to the existing (heavily-reviewed) function than a
 * small, separate one reusing the same manifest-resolution/hashing/audit
 * primitives it already reuses everywhere else in this file.
 *
 * Still reuses everything that must not be duplicated: `resolveExecutionManifest`/
 * `hashExecutionManifest` (the exact same hash `checkExecutionGate` will
 * later compare against — no second hashing scheme), the same
 * fingerprint-mismatch TOCTOU close `decideExecutionApproval` applies
 * (re-resolves and re-hashes at the moment of approval, 409s if the caller's
 * fingerprint is stale), and `appendLogAndEmit` for the audit trail.
 *
 * Eligibility (enforced by `taskRepo.preApproveExecution`'s guarded
 * compare-and-swap, not re-checked here — see that method's own doc comment):
 * `status = 'open'`, `pending_operation IS NULL`, `input_trust = 'untrusted'`.
 * A task outside that window (already gate-blocked, already running, or
 * trusted) cannot be pre-approved — the caller falls through to the normal
 * pending_approval panel instead.
 *
 * **Reachability note**: like every other route in this module, this is
 * reachable by any caller holding the UI/API token, not only the browser's
 * create-task form — the server has no way to distinguish "a human just
 * reviewed this in a form" from "a script called the same two HTTP
 * endpoints". The actual enforcement of "only the interactive create-form
 * triggers this" (task/328 part A-3) lives in the CALLER: only
 * TaskFormView's own create-and-approve flow calls this immediately after
 * `POST /api/tasks` for a github/gitlab-sourced task; MCP's `azt_create_task`
 * and the harness `/azt-issue`/`/azt-mission` skills deliberately do not
 * (task/328 part C) — a human has not reviewed the content in either of
 * those paths. This is the same trust boundary `decideExecutionApproval`
 * itself already relies on (an authenticated caller could equally script a
 * GET+POST against the real pending_approval panel's fingerprint without a
 * human ever looking at the screen); this function does not weaken it
 * further, only extends the same boundary to a second, narrower window
 * (a task that was never blocked at all).
 */
export function decideExecutionPreApproval(
  deps: ExecutionPreApprovalDeps,
  params: ExecutionPreApprovalParams,
  _log: ApprovalLogger,
): ExecutionApprovalOutcome {
  const { taskRepo, logRepo, unitRepo, projectRepo, projectServerRepo, serverRepo, projectSecretRepo, unitTypeLoader, sidekickLoader, events } = deps;
  const { taskId, unitId, fingerprint, origin } = params;

  const task = taskRepo.findById(taskId);
  if (!task) return { status: 404, body: { error: 'Task not found' } };
  if (task.inputTrust !== 'untrusted') {
    return { status: 400, body: { error: `Task ${taskId} is not untrusted-origin — there is nothing to pre-approve.` } };
  }
  if (task.status !== 'open' || task.pendingOperation !== null) {
    return {
      status: 409,
      body: {
        error: `Task ${taskId} is not eligible for creation-time pre-approval (status=${task.status}, pendingOperation=${task.pendingOperation ?? 'null'}) — it has already been gate-blocked or has moved past 'open'. Approve via the normal pending_approval panel instead.`,
        code: 'not_preapprovable',
      },
    };
  }

  // 'execute': creation-time pre-approval only applies to a task that is
  // still plain 'open' with no pendingOperation (checked above) — i.e.
  // strictly BEFORE its first execute() ever runs, so the current
  // project-server configuration is exactly what that first execute() is
  // about to distribute from.
  const { manifest } = resolveExecutionManifest(task, { unitRepo, projectRepo, projectServerRepo, serverRepo, projectSecretRepo, unitTypeLoader, sidekickLoader }, 'execute');
  const currentHash = hashExecutionManifest(manifest);
  if (fingerprint !== currentHash) {
    // Same TOCTOU close as decideExecutionApproval's fingerprint check above
    // — nothing has mutated task state yet, so the task is left exactly as
    // it was (still plain 'open') for the caller to re-fetch and retry, or
    // to just leave alone and let the normal pending_approval panel handle
    // approval on first execute.
    return {
      status: 409,
      body: {
        error: 'The execution manifest changed since you loaded this approval — re-check the current content before approving.',
        code: 'fingerprint_mismatch',
      },
    };
  }

  const written = taskRepo.preApproveExecution(taskId, currentHash);
  if (!written) {
    // Lost a race against something else that changed the task's state
    // between the read above and this write (e.g. a concurrent execute()
    // attempt that already gate-blocked it, or another pre-approval call).
    // Nothing was mutated by THIS call — same "leave it alone, let the
    // normal panel handle it" fallback as the fingerprint mismatch above.
    return {
      status: 409,
      body: { error: `Task ${taskId}'s pre-approval window has already closed (its state changed concurrently) — approve via the normal pending_approval panel instead.` },
    };
  }

  if (unitId !== null) {
    appendLogAndEmit(logRepo, events, taskId, unitId, 'command', { type: 'execution_pre_approved', origin });
  }
  return { status: 200, body: { ok: true } };
}
