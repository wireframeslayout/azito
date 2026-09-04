import { EventEmitter } from 'events';
import { randomUUID, randomBytes } from 'crypto';
import type { ITaskRepository, Task } from '../Task';
import type { TaskStatus } from '../TaskStatus';
import type { IUnitRepository, Unit } from '../../units/Unit';
import { usesHttpSignalPath } from '../../units/Unit';
import type { IServerRepository } from '../../servers/Server';
import type { IProjectRepository } from '../../projects/Project';
import type { IProjectServerRepository } from '../../projects/ProjectServer';
import { resolveEffectiveInputPolicy } from '../../projects/ProjectServer';
import type { SqliteProjectSecretRepository } from '../../projects/SqliteProjectSecretRepository';
import type { SidekickPackageLoader } from '../../sidekicks/SidekickPackageLoader';
import type { SidekickSyncService } from '../../sidekicks/SidekickSyncService';
import type { IExecutionLogRepository, LogType } from '../ExecutionLog';
import type { TmuxClient } from '../../tmux/TmuxClient';
import { confirmOldWindowGone, createRotatedWindow, createRotatedWindowInLock, ensureSessionWithLock, rollbackWindowReference, runExclusiveForTask, ServerSnapshotMismatchError, withServerLock, type ServerIsolationLock } from './WindowRotation';
import type { KeyedMutex } from '../../../shared/keyedMutex';
import type { IWorktreeService, WorktreeInfo } from '../../git/IWorktreeService';
import type { WorktreeServiceFactory } from '../../git/WorktreeServiceFactory';
import { PathResolverFactory, assertDirectoryContained } from '../../git/PathContainment';
import { normalizeBranchRef } from '../../git/assertSafeGitArgs';
import type { GitProviderService } from '../../git/providers/GitProviderService';
import type { ProjectRepositoryWithToken as ProjectRepository, ProjectRepository as ProjectRepositoryEntry } from '../../projects/Project';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import type { ServerConfig } from '../../servers/Server';
import { resolveCanonicalRepositoryIdentity } from '../../git/resolveCanonicalRepositoryIdentity';
import type { PaneClassifier } from '../../llm/PaneClassifier';
import type { IContentExtractor } from '../../llm/ContentExtractor';
import type { IWindowRepository } from '../../windows/Window';
import type { IPaneStreamFactory } from '../../tmux/PaneStream';
import type { ISessionStrategyFactory } from '../../agents/SessionStrategy';
import { buildWorkerLaunchCommand } from '../../agents/LaunchCommand';
import { shellQuote } from '../../../shared/shellQuote';
import { expandTemplate } from './PromptExpander';
import type { UnitTypeLoader } from '../../sidekicks/UnitTypeLoader';
import { WorkerWaiter } from './WorkerWaiter';
import { WorkerInputService } from './WorkerInputService';
import { PushVerifier } from './PushVerifier';
import { GitInfoCollector } from './GitInfoCollector';
import { PullRequestCreator } from './PullRequestCreator';
import { PhaseLoopRunner } from './PhaseLoopRunner';
import { appendLogAndEmit } from './AppendLog';
import { HttpSignalTurnCoordinator } from './HttpSignalTurnCoordinator';
import type { SupervisorRegistry } from '../../supervisors/SupervisorRegistry';
import { shouldSupervise } from '../../supervisors/SupervisorLaunch';
import { ResourceExhaustedError, type ResourceGuard } from '../../servers/resources/ResourceGuard';
import { checkExecutionGate, ExecutionGateDeniedError, ExecutionGatePendingApprovalError, reverifyExecutionGateInLock } from './ExecutionGate';
import { resolveExecutionManifest, hashExecutionManifest } from './ExecutionManifest';
import { TuiWorkerRuntime } from './runtime/TuiWorkerRuntime';
import { WorkerRuntimeRegistry } from './runtime/WorkerRuntimeRegistry';
import { resolveTaskServerName, resolveTmuxSession, resolveUnitId, resolveBaseBranch, canonicalizeBaseBranch, resolveWorktreeCreateBaseBranch } from './TaskExecutionEnv';
import { performDistribution, resolveExecutionRepositoryEntry, resolveRecordedDistributionRepositoryEntry, isDistributionRequired, isDistributionRequiredForContinuation, isDistributionRequiredButRepositoryUnresolved, shouldClearRecordedDistributionRepository, type DistributionOutcome } from './DistributionHelper';
import type { IDistributionStateRepository } from '../../git/hub-transfer/types';
import type { TaskPaneEnvironmentService } from './TaskPaneEnvironmentService';
import type { SqliteAgentTurnRepository } from '../turns/SqliteAgentTurnRepository';
import type { TurnSignalHub } from '../turns/TurnSignalHub';
import type { AgentTurn } from '../turns/AgentTurn';

// ─── Helpers ───

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Types ───

interface RunningExecution {
  taskId: number;
  target: string;
  windowTarget: string;
  serverName: string;
  abortController: AbortController;
}

// ─── Use Case ───
//
// "Operation" (see modules/operations/routes.ts) means one execution run of
// a Unit against a task; runningExecutions (keyed by unitId) is that run
// registry, exposed read-only via getRunning() / GET /api/operations.

export class ExecuteTaskUseCase {
  private runningExecutions = new Map<number, RunningExecution[]>();

  private readonly gitInfoCollector: GitInfoCollector;
  private readonly pushVerifier: PushVerifier;
  private readonly pullRequestCreator: PullRequestCreator;
  private readonly workerInput: WorkerInputService;
  private readonly workerWaiter: WorkerWaiter;
  private readonly phaseLoopRunner: PhaseLoopRunner;
  private readonly httpSignalCoordinator: HttpSignalTurnCoordinator;
  private readonly runtimeRegistry: WorkerRuntimeRegistry;
  private readonly pathResolverFactory = new PathResolverFactory();

  constructor(
    private taskRepo: ITaskRepository,
    private unitRepo: IUnitRepository,
    private serverRepo: IServerRepository,
    private projectRepo: IProjectRepository,
    private projectServerRepo: IProjectServerRepository,
    private sidekickLoader: SidekickPackageLoader,
    private logRepo: IExecutionLogRepository,
    private tmux: TmuxClient,
    private worktreeServiceFactory: WorktreeServiceFactory,
    private gitProvider: GitProviderService,
    private transportFactory: TransportFactory,
    private paneClassifier: PaneClassifier,
    private contentExtractor: IContentExtractor,
    private paneStreamFactory: IPaneStreamFactory,
    private windowRepo: IWindowRepository,
    private sessionStrategyFactory: ISessionStrategyFactory,
    private sidekickSyncService: SidekickSyncService,
    private turnRepo: SqliteAgentTurnRepository,
    private turnSignalHub: TurnSignalHub,
    private supervisorRegistry: SupervisorRegistry,
    private unitTypeLoader: UnitTypeLoader,
    private resourceGuard: ResourceGuard,
    private projectSecretRepo: SqliteProjectSecretRepository,
    // Shared task-events EventEmitter (Issue #328 fifteenth-round review) —
    // injected, not self-created, so TaskRestoreService and
    // WindowRespawnService can emit on the SAME instance buildServer.ts's
    // NotificationBus/push bridges subscribe to via
    // `executeTaskUseCase.events.on('log', ...)`. Before this, this class
    // created its own private EventEmitter that only ITS OWN appendLog()
    // calls (and PhaseLoopRunner's, injected from this class) ever emitted
    // on — TaskRestoreService.restore() and WindowRespawnService's
    // execution-gate enforcement wrote execution_log rows directly and had
    // no way to reach it, so a pending_approval block from either path was
    // silently unnotified. See AppendLog.ts's appendLogAndEmit() doc
    // comment for the shared helper this and those two classes now all use.
    public readonly events: EventEmitter,
    // Issue #28 Phase A後半: the sole task-pane env builder — see
    // TaskPaneEnvironmentService's own doc comment. Replaces this class's
    // former private buildExtraEnv() (removed), which only ever assembled
    // secrets + agent-server env and left AZITO_TASK_TOKEN unissued.
    private paneEnvService: TaskPaneEnvironmentService,
    // Issue #29 review (7th pass), Important finding 1: the SAME
    // per-server-name mutex `modules/servers/routes.ts`'s PUT handler and
    // `modules/tmux/routes/sessions.ts`'s manual window/pane routes already
    // serialize the isolation false->true transition against (see that
    // mutex's own doc comment) — required, not optional, so this class can
    // never construct a window without it. Passed straight through to
    // `WindowRotation.createRotatedWindow`/`createSecondaryWindow` bundled
    // with `serverRepo` as a `ServerIsolationLock` (see its own doc comment
    // in WindowRotation.ts for why env-resolution must be locked+refetched
    // through this exact key).
    private serverIsolationMutex: KeyedMutex,
    // Issue #29 Step 3a: threaded through to enforceExecutionGate() below and
    // to the PhaseLoopRunner instance this class constructs (its own
    // per-phase re-verification needs the identical flag) — resolved ONCE at
    // the composition root (app/wiring.ts, shared/auth/scopedAuthFlag.ts) and
    // passed down, never re-read from process.env here (Resolve at the
    // Boundary). Required (not optional) so a caller can never forget to
    // wire it and silently fall back to treating scoped auth as enabled.
    private scopedAuthEnabled: boolean,
    private sleepTaskWindows: (taskId: number) => Promise<number[]>,
    private pushNotaryService: import('../../git/hub-transfer/PushNotaryService').PushNotaryService | null = null,
    private fetchDistributionService: import('../../git/hub-transfer/FetchDistributionService').FetchDistributionService | null = null,
    // Issue #87 review (forge/87-mirror follow-up), Important finding 3: the
    // SAME instance `fetchDistributionService` itself writes to on every
    // successful distribution (see wiring.ts's `buildFetchDistributionService`)
    // — used by `shouldClearRecordedDistributionRepository` to decide whether
    // a not-required-this-run execute() may clear `task.distributionRepositoryId`.
    // Nullable only because some test fixtures don't wire it; when null,
    // there is no way to corroborate whether the current server still holds
    // the recorded repository's content, so — per this fix's "insufficient
    // information must fail toward keeping the record" rule — the record is
    // left untouched rather than cleared. See the field's use below.
    private distributionStateRepo: IDistributionStateRepository | null = null,
    private harnessPrefix?: string,
  ) {
    this.gitInfoCollector = new GitInfoCollector(this.tmux);
    this.pushVerifier = new PushVerifier(this.tmux, this.gitProvider);
    this.pullRequestCreator = new PullRequestCreator(
      this.taskRepo,
      this.gitProvider,
      (taskId, unitId, type, content) => this.appendLog(taskId, unitId, type, content),
    );
    this.workerInput = new WorkerInputService(
      this.tmux,
      this.supervisorRegistry,
      (taskId, unitId, type, content) => this.appendLog(taskId, unitId, type, content),
    );
    this.workerWaiter = new WorkerWaiter(
      this.tmux,
      this.paneClassifier,
      this.contentExtractor,
      this.paneStreamFactory,
      (taskId, unitId, type, content) => this.appendLog(taskId, unitId, type, content),
      (taskId) => this.taskRepo.touch(taskId),
      this.workerInput,
    );
    this.httpSignalCoordinator = new HttpSignalTurnCoordinator(this.turnRepo, this.turnSignalHub);
    const tuiRuntime = new TuiWorkerRuntime(this.tmux, this.workerInput, this.workerWaiter, this.httpSignalCoordinator, this.supervisorRegistry, this.harnessPrefix);
    this.runtimeRegistry = new WorkerRuntimeRegistry();
    this.runtimeRegistry.register('tui', tuiRuntime);
    this.phaseLoopRunner = new PhaseLoopRunner(
      this.taskRepo,
      this.projectRepo,
      this.projectServerRepo,
      this.unitRepo,
      this.sidekickLoader,
      this.workerWaiter,
      this.pushVerifier,
      this.gitInfoCollector,
      this.gitProvider,
      this.pullRequestCreator,
      (server) => this.getWorktreeService(server),
      (taskId, unitId, type, content) => this.appendLog(taskId, unitId, type, content),
      this.transportFactory,
      this.sidekickSyncService,
      this.httpSignalCoordinator,
      this.workerInput,
      this.unitTypeLoader,
      this.runtimeRegistry,
      this.serverRepo,
      this.projectSecretRepo,
      this.scopedAuthEnabled,
      this.pushNotaryService,
      this.sleepTaskWindows,
    );
  }

  // Bundled once per call (cheap object literal — `serverRepo`/`serverIsolationMutex`
  // themselves are the singletons) so createRotatedWindow/createSecondaryWindow
  // call sites below don't each re-spell the same two-field object. See
  // ServerIsolationLock's doc comment in WindowRotation.ts.
  private get serverIsolationLock(): ServerIsolationLock {
    return { serverIsolationMutex: this.serverIsolationMutex, serverRepo: this.serverRepo };
  }

  private getWorktreeService(server: ServerConfig): IWorktreeService {
    const transport = this.transportFactory.getTransport(server);
    return this.worktreeServiceFactory.create(server.type, transport);
  }

  /**
   * Thin wrapper over the shared `assertDirectoryContained` (modules/git/
   * PathContainment.ts) that resolves this class's transport for `server`.
   * The actual resolve+verify logic now lives in the shared function so
   * `TaskRestoreService` and `WindowRespawnService` can run the same check
   * without going through this use case (Issue #27 review finding 1) —
   * this method only exists to avoid repeating `getPathResolver`-style
   * transport wiring at each call site below. Returns the resolved
   * (symlink-free) path; callers must use that return value, not
   * `candidateDir`, for whatever follows (Issue #27 review finding 2).
   * Callers guard `candidateDir` truthiness themselves since failure
   * handling (log/fail-task/cleanup) differs by call site.
   */
  private async assertDirectoryContained(
    server: ServerConfig,
    { target, allowedRoot }: { target: string; allowedRoot: string | null | undefined },
    label: string,
  ): Promise<string> {
    const transport = this.transportFactory.getTransport(server);
    return assertDirectoryContained(this.pathResolverFactory, server.type, transport, { target, allowedRoot }, label);
  }

  /**
   * Runs the untrusted-input execution gate (Issue #328) and, when it
   * blocks, marks the task accordingly and throws before any worker,
   * worktree, or secret touches it. Called at the top of every entry point
   * here that can launch or resume a worker (execute/followUp/
   * resumeStateMachine); TaskRestoreService.restore and
   * WindowRespawnService.enforceExecutionGate run the same
   * checkExecutionGate()+resolveExecutionManifest() pairing independently
   * since they resolve their own task/server and have no dependency on this
   * use case. Returns the project/projectServer it resolved so callers that
   * need them anyway (execute()'s working-directory logic) don't re-fetch.
   *
   * `operation` records WHICH blocked entry point this was, in
   * task.pendingOperation, so the approval handler
   * (modules/tasks/execution/ExecutionApprovalDecision.ts's approve-execution) can resume the exact
   * operation a human approved instead of re-inferring it from
   * task.tmuxWindow (Issue #328 third-round review finding 1: that
   * heuristic couldn't tell "never started" apart from "was being
   * restored from archive", since TaskRestoreService.restore also blocks
   * before tmuxWindow is ever set — see ExecutionManifest.ts's module doc
   * comment for the related field-coverage discussion).
   * `execute()` passes 'execute' (fresh start, no window yet); followUp()/
   * resumeStateMachine() both pass 'resume' (continuing a run whose window
   * already exists) — both resume via resumeStateMachine() on approval,
   * matching the pre-existing behavior for those two entry points.
   */
  /**
   * Public (not private) because /api/tasks/:id/answer and
   * /api/units/:id/approve-plan (modules/tasks/routes.ts,
   * modules/units/routes.ts) need to run this exact check synchronously,
   * BEFORE consuming task.pendingQuestions/the submitted answers or feedback,
   * instead of discovering the block only after followUp() has already been
   * kicked off fire-and-forget (Issue #328 sixth-round review finding 1: that
   * ordering lost both the question record and the human's answer text on a
   * block). Reusing this method rather than a second gate-check
   * implementation keeps "what blocks execution" defined in exactly one
   * place.
   *
   * `operation` records WHICH blocked entry point this was — see the
   * per-operation transition table on Task.pendingOperation for the
   * authoritative list and what the approval handler does for each.
   * 'resume_await_answer'/'resume_await_plan_review' exist because those two
   * callers check the gate BEFORE persisting the human's answers/feedback:
   * unlike plain 'resume' (auto-resumed via resumeStateMachine() on
   * approval), these must NOT be auto-resumed, since nothing was persisted
   * for resumeStateMachine() to pick up — the approval handler instead
   * restores task.status to pendingOperationPriorStatus and leaves it for the
   * human to resubmit the same request (Issue #328 seventh-round review
   * symptom A).
   *
   * No `server: ServerConfig` parameter (Issue #328 tenth-round review
   * finding 1: this method used to take one and never read it — dead
   * wiring that masked the actual gap, which was that the MANIFEST itself
   * never resolved a ServerConfig at all, see ExecutionManifest.ts's
   * `server` field doc comment). resolveExecutionManifest() below now
   * resolves the target server itself, via the exact same `serverName`
   * every caller here already resolved before calling in — passing a
   * second, separately-captured copy through this parameter would be the
   * same divergent-resolution-path risk this file's callers already avoid
   * for Unit/projectServer.
   */
  enforceExecutionGate(
    task: Task,
    unitId: number,
    operation: 'execute' | 'resume' | 'resume_await_answer' | 'resume_await_plan_review',
  ) {
    // resolveExecutionManifest() re-resolves the same (task.unitId ??
    // project.defaultUnitId) / serverName the caller already resolved via
    // resolveExecutionEnv() — it's what turns the fingerprint into a
    // fingerprint of RESOLVED execution content instead of raw task columns
    // (see ExecutionManifest.ts). `project`/`projectServer` returned here are
    // reused by execute()'s working-directory logic below, same as before.
    //
    // operationKind: only `operation === 'execute'` is a FRESH run that has
    // not distributed anything yet this time — `performDistribution` is
    // about to read the CURRENT `projectServer.distributionRepositoryId`
    // regardless of what a past run recorded, so the gate must hash that
    // same current value ('execute'). Every other `operation` value here
    // ('resume'/'resume_await_answer'/'resume_await_plan_review') is
    // resuming a run whose working directory a past execute() already
    // populated — the recorded repository is authoritative for those
    // ('continuation'). See resolveExecutionManifest's own doc comment for
    // the full rationale (Issue #87 review, forge/87-mirror follow-up,
    // Important finding).
    const { manifest, project, projectServer, serverConfig } = resolveExecutionManifest(task, {
      unitRepo: this.unitRepo,
      projectRepo: this.projectRepo,
      projectServerRepo: this.projectServerRepo,
      serverRepo: this.serverRepo,
      projectSecretRepo: this.projectSecretRepo,
      unitTypeLoader: this.unitTypeLoader,
      sidekickLoader: this.sidekickLoader,
    }, operation === 'execute' ? 'execute' : 'continuation');
    const manifestHash = hashExecutionManifest(manifest);
    // Issue #29 Step 3a: the 3-point AND gate for 'allow' is re-evaluated on
    // every entry point, not just resolved once at approval time — see
    // resolveEffectiveInputPolicy's own doc comment for why (isolation
    // verification is a live, time-bounded fact, not something a human
    // approval should freeze).
    const effective = resolveEffectiveInputPolicy(projectServer, serverConfig, this.scopedAuthEnabled);
    if (effective.allowDegradedReason) {
      this.appendLog(task.id, unitId, 'command', {
        type: 'execution_policy_degraded',
        requestedPolicy: effective.requestedPolicy,
        effectivePolicy: effective.effectivePolicy,
        allowDegradedReason: effective.allowDegradedReason,
      });
    }
    const gate = checkExecutionGate(task, effective.effectivePolicy, manifestHash);
    if (gate.allowed) return { project, projectServer };

    this.appendLog(task.id, unitId, 'command', { type: 'execution_gate_blocked', reason: gate.reason });
    if (gate.reason === 'pending_approval') {
      // Atomic compare-and-swap (Issue #328 review round): a second blocked
      // entry point (e.g. a follow-up racing an execute() for the same
      // untrusted task) must NOT overwrite an already-recorded
      // pendingOperation/pendingOperationPriorStatus — see
      // recordExecutionGateBlock's doc comment on ITaskRepository for why
      // the old unconditional `taskRepo.update(...)` here could both lose
      // the first block's operation identity AND corrupt
      // pendingOperationPriorStatus with 'pending_approval' itself.
      // manifestHash is passed through so the guarded UPDATE can also detect
      // a concurrent approval that already matches this exact manifest
      // (Issue #328 review round fix 2).
      const recorded = this.taskRepo.recordExecutionGateBlock(task.id, {
        pendingOperation: operation,
        priorStatus: task.status,
        manifestHash,
      });
      if (recorded) {
        // Separate 'status_change' log entry (Issue #51), not just the
        // 'command' entry above — buildServer.ts's NotificationBus bridge
        // (`executeTaskUseCase.events.on('log', ...)`) only turns a
        // 'status_change' entry into a `task:status` WS event, the same
        // mechanism that already surfaces 'waiting_for_human'/'phase_review'
        // as browser notifications. Without this, a task blocked here would
        // sit at pending_approval with no notification ever reaching the UI.
        this.appendLog(task.id, unitId, 'status_change', { status: 'pending_approval', operation });
      } else {
        // Another operation is already recorded as the pending block — the
        // first block's own 'status_change' already notified the client;
        // logging a second one here would misreport `operation` as the one
        // that will actually resume on approval.
        this.appendLog(task.id, unitId, 'command', { type: 'execution_gate_already_pending', operation });
      }
      throw new ExecutionGatePendingApprovalError(task.id);
    }
    // 'denied': leave task status untouched — same rationale as the resource
    // guard's pre-launch block above (task hasn't started, nothing to roll
    // back) but unlike that block this isn't transient; a human must change
    // the project server's input_policy before a retry can succeed.
    throw new ExecutionGateDeniedError(task.id);
  }

  /**
   * In-lock counterpart of {@link enforceExecutionGate} (Issue #29 Step 3a
   * review, Important finding 2): re-resolves the manifest from `currentTask`
   * (the row re-read inside `runExclusiveForTask`, not the possibly-stale
   * `task` `enforceExecutionGate` ran against before either lock was queued
   * for) and re-runs `resolveEffectiveInputPolicy()`/`checkExecutionGate()`
   * against `freshServer` — the row `withServerLock` already re-read once
   * the per-server isolation lock was actually acquired. Passed as
   * `createRotatedWindow`/`createRotatedWindowInLock`'s `preCheck` so it
   * runs immediately before any task-token/secret env is built, not after.
   * See `ExecutionGate.reverifyExecutionGateInLock`'s own doc comment for
   * the TOCTOU this closes.
   *
   * Returns the `project`/`projectServer` snapshot this in-lock resolution
   * actually gated against (Issue #87 16th-round review, Important finding
   * 2): the caller's own `projectServer`/`project` were resolved by
   * `enforceExecutionGate` BEFORE the resource guard, workingDir
   * containment, and window creation — none of which hold any lock — so a
   * `distribute_code` toggle landing in that window would leave
   * `performDistribution` (called after this preCheck returns) deciding
   * against a snapshot older than the one the gate itself just re-verified
   * with. Returning it here lets the caller re-point `performDistribution`
   * and the base-branch resolution feeding it at the SAME snapshot the gate
   * passed, without re-querying a third time.
   */
  private reverifyGateInLock(
    currentTask: Task,
    unitId: number,
    operation: NonNullable<Task['pendingOperation']>,
    freshServer: ServerConfig,
  ): { project: ReturnType<typeof resolveExecutionManifest>['project']; projectServer: ReturnType<typeof resolveExecutionManifest>['projectServer'] } {
    // Same 'execute' vs 'continuation' mapping as enforceExecutionGate()
    // above — only a FRESH execute() (never distributed anything this run)
    // may hash the CURRENT project-server repository config; every other
    // `operation` value re-verifies a run that is already resuming/
    // continuing past distribution.
    const { manifest, project, projectServer } = resolveExecutionManifest(currentTask, {
      unitRepo: this.unitRepo,
      projectRepo: this.projectRepo,
      projectServerRepo: this.projectServerRepo,
      serverRepo: this.serverRepo,
      projectSecretRepo: this.projectSecretRepo,
      unitTypeLoader: this.unitTypeLoader,
      sidekickLoader: this.sidekickLoader,
    }, operation === 'execute' ? 'execute' : 'continuation');
    const manifestHash = hashExecutionManifest(manifest);
    reverifyExecutionGateInLock(
      { taskRepo: this.taskRepo, logRepo: this.logRepo, events: this.events },
      currentTask,
      unitId,
      operation,
      projectServer,
      freshServer,
      this.scopedAuthEnabled,
      manifestHash,
    );
    return { project, projectServer };
  }

  private appendLog(taskId: number, unitId: number, type: LogType, content: unknown): void {
    appendLogAndEmit(this.logRepo, this.events, taskId, unitId, type, content);
  }

  /**
   * Shared cleanup for a failure that happens AFTER the task window was
   * already created and the task marked `in_progress` (execute()'s
   * post-window-creation span: fetch distribution, worktree creation,
   * worktree path containment) — review finding (Issue #87 third-party
   * review, Important 1): the fetch-distribution failure branch used to only
   * `throw`, leaving the task `in_progress` with a live, still-authenticated
   * window and an un-revoked token. This factors out exactly the rollback
   * the pre-existing worktree-failure branches already performed (marks the
   * task `failed`, then kills the window and revokes ITS OWN generation's
   * token via {@link rollbackWindowReference}) so a THIRD failure branch
   * doesn't reimplement it a third time.
   *
   * `extraTaskUpdate` lets a caller merge in `worktreePath`/`worktreeBranch`
   * (e.g. `null, null` for the path-rejected branch) into the SAME
   * generation-guarded `updateStatusIfWindowMatches` UPDATE as the status
   * write — not a separate, unconditional `taskRepo.update()` call. Issue
   * #87 third-party review, seventh pass, Important finding 2: a second
   * unconditional `update()` after the guarded status write clobbered
   * `worktreePath`/`worktreeBranch` even when the guard had just refused the
   * status write because a NEWER generation had already persisted its own
   * worktree for this same task — the stale rollback erased a live
   * execution's worktree info. Routing both through one guarded statement
   * means the guard not matching now blocks BOTH fields, not just status.
   *
   * Scoped to `tokenId` (the generation `createRotatedWindow` issued for
   * THIS execute() call, inside `runExclusiveForTask`), not the whole task —
   * a blanket revoke here could otherwise clobber a newer generation a
   * concurrent rotation for this task already persisted. `tmuxWindow` is
   * cleared only once the kill is CONFIRMED gone, via
   * `clearTmuxWindowIfMatches(taskId, windowName)` (gated on this call's own
   * `windowName`) — never an unconditional null-out, for the same reason
   * (see the original worktree_failed/worktree_path_rejected comments this
   * replaces for the full Issue #28 third-party review history behind these
   * two properties). Errors from the rollback itself are swallowed (best
   * effort) — same as the two call sites this replaces — since surfacing
   * them here would replace the caller's own actual failure message.
   *
   * Issue #87 third-party review, Important finding 1: this whole span runs
   * OUTSIDE `runExclusiveForTask` (same gap as the window-reference clear
   * above), so a concurrent execute()/followUp() for the SAME task can
   * already have created its OWN newer window generation and moved the task
   * to `in_progress` while THIS call's post-window-creation step is still
   * failing and about to roll back. An unconditional `update(taskId, {
   * status: 'failed' })` would stomp that newer, still-live execution's
   * status. The status write now goes through
   * `updateStatusIfWindowMatches(taskId, windowName, 'failed')` — gated on
   * this call's own `windowName`, exactly like `clearTmuxWindowIfMatches`
   * above — so it becomes a no-op once the row has moved on to a different
   * generation. `extraTaskUpdate` (worktreePath/worktreeBranch on the
   * worktree_path_rejected branch) is passed through to the SAME guarded
   * call (seventh pass, Important finding 2) instead of a second
   * unconditional `taskRepo.update()` — see that method's own doc comment
   * for the clobber this closes.
   */
  private async rollbackWindowAfterPostCreationFailure(
    taskId: number,
    server: ServerConfig,
    tmuxSession: string,
    windowName: string,
    tokenId: number,
    revokeReason: string,
    extraTaskUpdate?: { worktreePath: string | null; worktreeBranch: string | null },
  ): Promise<void> {
    if (extraTaskUpdate) {
      this.taskRepo.updateStatusIfWindowMatches(taskId, windowName, 'failed' as TaskStatus, tokenId, extraTaskUpdate);
    } else {
      this.taskRepo.updateStatusIfWindowMatches(taskId, windowName, 'failed' as TaskStatus, tokenId);
    }
    try {
      await rollbackWindowReference(
        this.tmux.killWindow(server, `${tmuxSession}:${windowName}`),
        this.paneEnvService,
        tokenId,
        revokeReason,
        () => this.taskRepo.clearTmuxWindowIfMatches(taskId, windowName),
        () => {},
      );
    } catch {}
  }

  /**
   * Marks the task `failed` and logs when `err` is a
   * {@link ServerSnapshotMismatchError} (Issue #29 review, 12th pass,
   * Critical finding 1) — the server row `ensureSessionWithLock`/
   * `createRotatedWindow` re-read once the isolation lock was actually held
   * disagreed with the one this run's execution gate / resource / containment
   * checks ran against, so continuing would mean acting on an endpoint or
   * credential set that was never the one approved. Every call site below
   * that wraps `ensureSessionWithLock`/`createRotatedWindow` checks this
   * first, before any generic error-wrapping of its own, so the mismatch
   * error's identity survives for callers/tests that want to distinguish it
   * — returns whether `err` was in fact a mismatch, purely so call sites can
   * decide whether to fall through to their own generic handling.
   */
  private failOnServerSnapshotMismatch(err: unknown, taskId: number, unitId: number): boolean {
    if (!(err instanceof ServerSnapshotMismatchError)) return false;
    this.appendLog(taskId, unitId, 'command', { type: 'server_snapshot_mismatch', message: err.message });
    this.taskRepo.update(taskId, { status: 'failed' as TaskStatus } as Partial<Task>);
    return true;
  }

  /**
   * Resolves the PR/MR URL for a branch via GitProviderService. Returns null
   * (not a fallback CLI guess) when the repo has no owner/name or the lookup
   * fails — PR URL is best-effort metadata, never a phase-completion gate.
   */
  private async findPrUrl(repo: ProjectRepository | null | undefined, branch: string | null): Promise<string | null> {
    if (!branch || !repo || !repo.owner || !repo.repoName) return null;
    try {
      const pr = await this.gitProvider.findPullRequestByBranch(repo, branch);
      return pr?.htmlUrl ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Resolves "where" (serverName/tmuxSession) and "what" (Unit — behavior +
   * runtime) a task runs with. Fail-fast: when either cannot be resolved,
   * marks the task failed with a log entry and throws (no implicit default
   * server or Unit) — mirrors the existing worktree-creation failure
   * pattern.
   *
   * `requestedUnitId` is the Unit id the caller addressed (the `:id` of
   * /api/units/:id/execute|follow-up|resume etc.), which is also the key used
   * for execution logs and the runningExecutions map. It MUST equal the Unit
   * the task actually resolves to (`task.unitId ?? project.defaultUnitId`) —
   * otherwise the task would run with one Unit's runtime while its logs and
   * run registry point at another. A mismatch fails fast instead of silently
   * preferring either side.
   */
  private resolveExecutionEnv(task: Task, requestedUnitId: number): { serverName: string; tmuxSession: string; unit: Unit } {
    const serverName = resolveTaskServerName(task, this.projectServerRepo);
    if (!serverName) {
      const message = 'Cannot resolve execution server: task has no serverName and its project does not have exactly one project_servers entry';
      this.appendLog(task.id, requestedUnitId, 'command', { type: 'env_resolution_failed', message });
      this.taskRepo.updateStatus(task.id, 'failed' as TaskStatus);
      throw new Error(message);
    }

    const project = this.projectRepo.findById(task.projectId);
    const resolvedUnitId = resolveUnitId(task, project);
    if (!resolvedUnitId) {
      const message = 'Cannot resolve Unit: task has no unitId and its project has no defaultUnitId';
      this.appendLog(task.id, requestedUnitId, 'command', { type: 'env_resolution_failed', message });
      this.taskRepo.updateStatus(task.id, 'failed' as TaskStatus);
      throw new Error(message);
    }

    if (resolvedUnitId !== requestedUnitId) {
      // Request/task disagreement, not a broken task — leave the task status
      // untouched so the caller can simply re-issue against the right Unit.
      const message = `Unit mismatch: request addressed unit ${requestedUnitId}, but task ${task.id} resolves to unit ${resolvedUnitId} (task.unitId ?? project.defaultUnitId). Re-issue the request against unit ${resolvedUnitId}.`;
      this.appendLog(task.id, requestedUnitId, 'command', { type: 'env_resolution_failed', message });
      throw new Error(message);
    }

    const unit = this.unitRepo.findById(resolvedUnitId);
    if (!unit) {
      const message = `Unit ${resolvedUnitId} not found`;
      this.appendLog(task.id, requestedUnitId, 'command', { type: 'env_resolution_failed', message });
      this.taskRepo.updateStatus(task.id, 'failed' as TaskStatus);
      throw new Error(message);
    }

    const tmuxSession = resolveTmuxSession(task.projectId, serverName, this.projectServerRepo);
    return { serverName, tmuxSession, unit };
  }

  async execute(unitId: number, taskId: number, options?: { force?: boolean }): Promise<void> {
    const unitForRun = this.unitRepo.findById(unitId);
    if (!unitForRun) throw new Error('Unit not found');

    const task = this.taskRepo.findById(taskId);
    if (!task) throw new Error('Task not found');

    // No blunt "task.unitId is required" guard here: resolveExecutionEnv already
    // fails fast (marks the task failed, throws) when neither task.unitId nor
    // project.defaultUnitId resolves to a Unit — same fallback the old
    // workerProfileId resolution used, now merged into Unit (Issue #263 Refine B).
    const { serverName, tmuxSession, unit } = this.resolveExecutionEnv(task, unitId);

    const serverAtStart = this.serverRepo.findByName(serverName);
    if (!serverAtStart) throw new Error('Server not found');
    // `let`, not `const`: reassigned below (ensureSessionWithLock,
    // createRotatedWindow) to whatever fresher row the isolation lock
    // re-read — explicitly typed `ServerConfig` (not inferred from
    // `findByName`'s nullable return) so TS control-flow narrowing isn't
    // lost the moment this variable is captured by a nested closure below
    // (createRotatedWindow's `create` callback, runExclusiveForTask's
    // callback, ...), which would otherwise re-widen every later use back
    // to `ServerConfig | null`.
    let server: ServerConfig = serverAtStart;

    // Untrusted-input execution gate (Issue #328): must run before the
    // resource guard, before any tmux window, before any worktree, before
    // any secret is injected. Resolves project/projectServer once for reuse
    // below.
    const { project, projectServer } = this.enforceExecutionGate(task, unitId, 'execute');

    // リソースひっ迫時はウィンドウ作成前に中断する（タスクは開始前なので status は変更しない）。
    // force 指定（フロントの「それでも実行」）でスキップできる。
    if (options?.force !== true) {
      const resourceStatus = await this.resourceGuard.check(server);
      if (!resourceStatus.ok) {
        this.appendLog(taskId, unitId, 'command', { type: 'resource_guard_blocked', resources: resourceStatus });
        throw new ResourceExhaustedError(server.name, resourceStatus);
      }
    }

    // Change to project working directory (use worktree if possible)
    // allowedRoot is the project's configured working directory — the boundary
    // a caller-supplied task.workingDirectory must not escape (Issue #27:
    // task.workingDirectory comes straight from the API with no path
    // validation beyond shell-metachar rejection, so `..`/absolute-path
    // escapes were previously possible). When the project has no configured
    // working directory there is no boundary to enforce, so containment is
    // skipped and the legacy behavior (run wherever task.workingDirectory
    // points) is preserved rather than guessed at.
    const allowedRoot = projectServer?.workingDirectory || null;
    let workingDir = task.workingDirectory || allowedRoot;
    let effectiveDir = workingDir;

    // Verified before any tmux window is touched (Important review finding):
    // a rejected path used to be discovered only after the pre-existing pane
    // had already been killed and a replacement window created, forcing the
    // catch block to kill that replacement too. Checking containment first
    // means a rejection leaves tmux state untouched and the task simply never
    // starts, instead of destroying and recreating a window for nothing.
    if (task.workingDirectory && allowedRoot) {
      try {
        // Use the resolved (symlink-free) path returned by the check for
        // worktree creation below, not the original task.workingDirectory —
        // otherwise a symlink swapped in between verification and use could
        // still redirect the worktree outside allowedRoot (Issue #27 review
        // finding 2, TOCTOU).
        workingDir = await this.assertDirectoryContained(server, { target: task.workingDirectory, allowedRoot }, 'task working directory');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.appendLog(taskId, unitId, 'command', {
          type: 'working_directory_rejected',
          message,
        });
        this.taskRepo.update(taskId, { status: 'failed' as TaskStatus } as Partial<Task>);
        throw new Error(`Task working directory rejected: ${message}`);
      }
    }

    // Ensure tmux session exists. This bootstrap window (if the session
    // doesn't exist yet) is immediately abandoned in favor of the real task
    // window created below — it deliberately gets no task token (issuing/
    // rotating one for a window nobody uses would be pointless). It IS still
    // routed through `ensureSessionWithLock`'s `isolationMaskForServer`
    // (Issue #29 review, 11th pass, Critical finding 1 — not a bare `{}`,
    // and NOT `uiTokenEnvForServer` either, since this is a TASK session and
    // must never inject the live operator UI token the way
    // `uiTokenEnvForServer` does for a non-isolated server): a bare `{}`
    // injects nothing itself, but does nothing to mask a credential the
    // pane inherits anyway — either from the tmux SESSION's own leftover
    // env, or from the tmux SERVER process's own env (the remote agent
    // process's env, for an `agent`-type server) — so an isolated server
    // still needs the explicit mask here exactly like every other
    // window-creation call site does.
    //
    // Routed through ensureSessionWithLock (Issue #29 review, 10th pass,
    // Critical finding 1): the existence check AND the createSession call
    // both now run inside `serverIsolationLock`, against a `server` row
    // re-read only once the lock is held — never against the `server`
    // resolved above, which a concurrent isolation PUT may have already
    // superseded. `server` is reassigned to the fresh row so every
    // subsequent use in this function (including the real task-window
    // creation below) sees it too.
    let sessionResult: { created: boolean; server: ServerConfig };
    try {
      sessionResult = await ensureSessionWithLock(this.tmux, this.serverIsolationLock, server, tmuxSession);
    } catch (err) {
      this.failOnServerSnapshotMismatch(err, taskId, unitId);
      throw err;
    }
    server = sessionResult.server;
    if (sessionResult.created) {
      await sleep(500);
    }

    // Kill existing task window if leftover, and confirm it's actually gone
    // BEFORE the token rotation below (Issue #28 third-party review,
    // execute() rollback-safety finding): this used to be an unconditional
    // best-effort `catch {}` with nothing gating the rotation that followed
    // — a kill failure left a still-live pane while a fresh token was issued
    // anyway. confirmOldWindowGone throws (aborting execute() before any
    // rotation happens) when a task-owned old window survives the kill.
    //
    // kind MUST be 'window', not 'pane' (Issue #28 third-party review finding
    // 1): a task window can hold multiple panes (e.g. a split terminal the
    // user opened alongside the worker pane), and killPane only kills the
    // active pane. A surviving sibling pane would still be authenticated
    // with the token this rotation is about to revoke, and the old task
    // window would linger alongside the freshly-created one instead of being
    // replaced by it.
    // The whole confirm-kill -> rotate-token -> create -> persist span runs
    // under a per-task lock (Issue #28 third-party review, design v3 §2):
    // without it, a concurrent rotation for this same task (e.g. a respawn
    // triggered from the UI while this execute() is still creating its
    // window) could issue a newer generation that revokes THIS generation
    // before it gets persisted below — see runExclusiveForTask's doc comment
    // in WindowRotation.ts.
    let windowName: string;
    let tokenId: number;
    let createdServer: ServerConfig;
    // Reassigned by reverifyGateInLock's preCheck below with the
    // project/projectServer snapshot the in-lock gate re-verification
    // actually ran against (Issue #87 16th-round review, Important finding
    // 2) — falls back to the pre-lock `project`/`projectServer` (from
    // `enforceExecutionGate` above) only if the lock is somehow never
    // acquired (e.g. `runExclusiveForTask`/`withServerLock` throwing before
    // reaching `reverifyGateInLock`, in which case execute() never reaches
    // the distribution call below anyway).
    let lockedProject = project;
    let lockedProjectServer = projectServer;
    try {
      ({ windowName, tokenId, server: createdServer } = await runExclusiveForTask(taskId, async () => {
        // Task/tmux state is re-read HERE, inside the lock (Issue #28
        // third-party review, TOCTOU finding) — not taken from the `task`
        // captured before this lock was even queued for. Without this, a
        // second execute()/followUp() queued behind this one on
        // runExclusiveForTask still decides what to kill using the SAME
        // stale `task.tmuxWindow` its own pre-lock snapshot had, i.e. the
        // window that existed before EITHER call started — not the window
        // this call is about to create. Concretely: call A (this one) creates
        // generation A's window; call B, still holding its own stale
        // snapshot, sees that same old (pre-A) window as "the" window to
        // kill, finds it already gone (or races the kill against A live),
        // and creates generation B — whose issueNextGeneration() revokes
        // generation A regardless, since A's window was never what B tried
        // to kill. Generation A's pane is now orphaned with a dead token.
        // Re-fetching `currentTask` here means each queued rotation always
        // targets whatever the immediately-prior rotation for this task
        // actually persisted.
        const currentTask = this.taskRepo.findById(taskId);
        if (!currentTask) throw new Error(`Task ${taskId} not found`);

        // Issue #29 review, 14th pass, Important finding 1: the per-server
        // isolation lock is now acquired — and `server`'s snapshot verified
        // against the freshly re-read row — BEFORE the old window is
        // killed, not after. This used to kill the old window using the
        // (possibly stale) `server` argument from before either lock was
        // even queued for, and only reached the snapshot check afterwards
        // inside `createRotatedWindow` — so a mismatch aborted AFTER the
        // kill had already run, leaving `tmuxWindow` pointing at a
        // now-dead window with no replacement ever created. `withServerLock`
        // performs the lock+refetch+snapshot-check first; the kill and the
        // window creation both run inside its callback, against the same
        // `freshServer` row, so a mismatch now aborts before anything is
        // killed.
        const { windowName: newWindowName, tokenId: newTokenId, server: newServer } = await withServerLock(this.serverIsolationLock, server, true, async (freshServer) => {
          if (currentTask.tmuxWindow) {
            const preCheck = await this.tmux.listSessions(freshServer);
            const preSession = preCheck.find((s) => s.name === tmuxSession);
            const oldWin = preSession?.windows.find((w) => w.name === currentTask.tmuxWindow);
            await confirmOldWindowGone(
              this.tmux,
              freshServer,
              oldWin ? { target: `${tmuxSession}:${oldWin.index}`, kind: 'window' } : null,
              task.id,
            );
            if (oldWin) await sleep(300);
          }

          // Create a new tmux window for the task — this call is the actual
          // window-generation point, so it's the one that rotates the task
          // token (TaskPaneEnvironmentService.buildEnvForNewWindow; design v3
          // §2). createRotatedWindowInLock revokes the freshly-issued
          // generation if creation fails, whether by throwing (local
          // transport) or resolving with a non-zero exit code (agent
          // transport — see WindowRotation.ts's doc comment; Issue #28
          // third-party review finding).
          return createRotatedWindowInLock(this.paneEnvService, freshServer, currentTask, 'execute_create_failed', (fs, env) =>
            this.tmux.createWindow(fs, tmuxSession, `task-${task.id}`, { extraEnv: env }),
            (fs) => {
              const locked = this.reverifyGateInLock(currentTask, unitId, 'execute', fs);
              lockedProject = locked.project;
              lockedProjectServer = locked.projectServer;
            },
          );
        });

        this.taskRepo.update(taskId, { status: 'in_progress' as TaskStatus, tmuxWindow: newWindowName });
        // `server` is returned too (Issue #29 review, 10th pass, Important
        // finding 3) — the lock re-read and actually created the window
        // with this row; everything execute() does past this point
        // (resolvePaneId, the worktree transport, the rollback's killWindow)
        // must keep using it, not the (possibly now-stale) `server` this
        // closure captured from its own outer scope.
        return { windowName: newWindowName, tokenId: newTokenId, server: newServer };
      }));
    } catch (err) {
      if (this.failOnServerSnapshotMismatch(err, taskId, unitId)) throw err;
      // Issue #29 Step 3a review, Important finding 2: reverifyGateInLock
      // (run as this window creation's `preCheck`, above) throws the SAME
      // ExecutionGate* errors enforceExecutionGate() throws pre-lock — these
      // must survive identity-intact for replyToExecutionGateError()
      // (routes.ts) to translate correctly, not be swallowed into the
      // generic "Failed to create tmux window" wrap below.
      if (err instanceof ExecutionGateDeniedError || err instanceof ExecutionGatePendingApprovalError) throw err;
      throw new Error(`Failed to create tmux window: ${err instanceof Error ? err.message : err}`);
    }
    server = createdServer;

    const windowTarget = `${tmuxSession}:${windowName}`;
    const target = await this.tmux.resolvePaneId(server, windowTarget);

    // Canonicalized ONCE, immediately after resolution (Issue #87
    // third-party review, 11th round, Important finding 1) — see
    // `canonicalizeBaseBranch`'s doc comment in TaskExecutionEnv.ts. Computed
    // unconditionally (not only when `workingDir` is set) because fetch
    // distribution's own prerequisite checks (via performDistribution) need
    // it regardless of whether a working directory happens to be configured.
    // Resolved from `lockedProjectServer`/`lockedProject` (Issue #87
    // 16th-round review, Important finding 2), not the pre-lock
    // `projectServer`/`project` — see reverifyGateInLock's doc comment.
    const baseBranch = canonicalizeBaseBranch(resolveBaseBranch(task, lockedProjectServer, lockedProject));

    // Fetch distribution (Issue #87 Phase 1: isolated servers, unconditionally
    // — they hold no git credentials of their own, so distribution is not
    // optional there. Issue #87 Phase 2: generalized to any non-`local`
    // server via the project's own `distribute_code` opt-in, for instant
    // dev-environment provisioning without hub-side credentials on the
    // target. `local` is always excluded — that server IS the hub, so
    // "distributing" to it is meaningless.)
    //
    // Extracted into performDistribution() (Issue #87 13th-round review,
    // Important finding 1): TaskRestoreService.restore() shares this exact
    // prerequisite-check-and-distribute sequence, so a task restored on an
    // isolated/distribute_code server goes through the same distribution a
    // fresh execute() would, instead of silently recreating its worktree
    // from whatever stale content happens to already be at `workingDir`.
    // Rollback (window/token teardown) and task-status handling stay HERE —
    // restore()'s own failure handling differs enough (a single outer
    // try/catch spanning window+worktree creation) that folding it into the
    // shared helper would either lose information this call site uses or
    // force restore() to adopt a rollback shape it doesn't have.
    // Issue #87 review follow-up (Important finding 1): persist the
    // distribution TARGET before performDistribution() may mutate the
    // remote working directory, not only after it returns successfully.
    // Writing only on success (the old code below) left a window — a crash,
    // or a thrown error, between a successful distribute() and that write —
    // where `distributionRepositoryId` still held whatever a PRIOR run
    // recorded (or null). A later resume/restore that trusts this column
    // (resolveRecordedDistributionRepositoryEntry) could then validate/push
    // a working tree THIS run actually populated from target B against a
    // stale recorded target A.
    //
    // Issue #87 review follow-up (second round, Important finding 1): that
    // first fix wrote this record BEFORE `performDistribution()` even ran —
    // too early. `performDistribution()` itself starts with several
    // prerequisite checks (`service_not_wired`/`no_working_dir`/
    // `no_distribution_repository`/`distribution_repository_not_found`/
    // `no_token`/`identity_unresolvable`, DistributionHelper.ts) that never
    // touch the remote. If a re-execution targets a DIFFERENT repository
    // than the one a prior run actually distributed, and this run then
    // fails one of those checks, the working directory is left exactly as
    // the prior run left it (repository A) while the record above would
    // already have been overwritten to name the new target (repository B) —
    // the record would point at a repository the working directory was
    // never populated from, and a later resume/push could validate/push
    // A's content against B. So the write is now done via
    // `onBeforeDistribute`, a callback `performDistribution()` invokes
    // itself, exactly once, immediately before the one call that can
    // actually mutate the remote — i.e. only after every prerequisite check
    // has passed. A prerequisite failure therefore leaves the previous
    // record untouched. See `onBeforeDistribute`'s doc comment in
    // DistributionHelper.ts. `TaskRestoreService.restore()` mirrors this
    // same ordering.
    const distOutcome: DistributionOutcome = await performDistribution({
      server,
      projectServer: lockedProjectServer,
      project: lockedProject,
      workingDir,
      baseBranch,
      taskBranch: task.branch,
      transportFactory: this.transportFactory,
      projectRepo: this.projectRepo,
      fetchDistributionService: this.fetchDistributionService,
      onBeforeDistribute: (repositoryId) => {
        this.taskRepo.update(taskId, { distributionRepositoryId: repositoryId } as Partial<Task>);
      },
    });
    if (distOutcome.required && !distOutcome.ok) {
      this.appendLog(taskId, unitId, 'command', { type: 'fetch_distribution_failed', error: distOutcome.message });
      const rollbackReason = distOutcome.stage === 'distribute_failed'
        ? 'fetch_distribution_failed_rollback'
        : distOutcome.stage === 'stale_local_branch'
          ? 'fetch_distribution_stale_local_branch_rollback'
          : 'fetch_distribution_prereq_failed_rollback';
      await this.rollbackWindowAfterPostCreationFailure(taskId, server, tmuxSession, windowName, tokenId, rollbackReason);
      // No write here — and whether one already happened depends on which
      // stage failed. `onBeforeDistribute` (passed to `performDistribution`
      // above) only fires once every prerequisite check has passed, right
      // before the actual `distribute()` call:
      // - A pure prerequisite failure (`service_not_wired`/`no_working_dir`/
      //   `no_distribution_repository`/`distribution_repository_not_found`/
      //   `no_token`/`identity_unresolvable`) never reached that point —
      //   `onBeforeDistribute` did NOT fire, so whatever a PRIOR run
      //   recorded is still there, untouched, correctly describing the
      //   working directory's actual (unchanged-by-this-run) content.
      // - `distribute_failed`/`stale_local_branch` fail AFTER
      //   `onBeforeDistribute` already fired — the record already names
      //   what THIS run attempted to distribute, which is either what's
      //   actually on disk now or a broken worktree that must be
      //   re-validated/failed-closed against that SAME repository.
      throw new Error(distOutcome.message);
    }
    if (distOutcome.required) {
      this.appendLog(taskId, unitId, 'command', { type: 'fetch_distributed', sha: distOutcome.sha, bundleType: distOutcome.bundleType });
      // Already persisted via `onBeforeDistribute` inside
      // `performDistribution()` (see above) — `distOutcome.repositoryId` is
      // always the same id resolved there, so writing it again here would
      // only be a redundant, idempotent duplicate of the SAME record. Not
      // repeated, to keep this a single source of truth rather than two
      // write sites that could drift.
    } else {
      // Issue #87 review follow-up, Important finding 4, superseded by Issue
      // #87 review (forge/87-mirror follow-up), Important finding 3: this run
      // did NOT distribute — but `required: false` only means "not required
      // THIS run", not "the working directory holds nothing from a past
      // distribution". Unconditionally clearing here (the previous fix) broke
      // exactly the common case of disabling `distributeCode` on a server that
      // had already distributed: the checkout stays on disk, the worktree
      // created right below still comes from it, but every downstream
      // consumer of `task.distributionRepositoryId`
      // (`resolveRecordedDistributionRepositoryEntry`) fell back to
      // `project.repositories[0]` — silently retargeting push/PR verification
      // at a different repository than what's actually checked out.
      //
      // `shouldClearRecordedDistributionRepository` (DistributionHelper.ts)
      // only returns `true` when it has positive evidence this run's server
      // does NOT hold the recorded repository's distributed content (no
      // matching `distribution_state` row) — the case Important finding 4
      // above was actually guarding against (server switched away from
      // isolated/distribute_code). When it cannot tell (`distributionStateRepo`
      // not wired), the record is left untouched — "insufficient information
      // fails toward keeping the record", not toward clearing it.
      if (this.distributionStateRepo && shouldClearRecordedDistributionRepository(this.distributionStateRepo, server.name, task.distributionRepositoryId)) {
        this.taskRepo.update(taskId, { distributionRepositoryId: null } as Partial<Task>);
      }
    }
    // Tracks fetch distribution's outcome this call (null when distribution
    // did not run, e.g. a `local` server, or an agent/ssh server whose
    // project_servers row has distribute_code off) — see
    // resolveWorktreeCreateBaseBranch's doc comment for why this decides
    // whether worktree creation below resolves `origin/<baseBranch>` instead
    // of the plain `baseBranch`.
    const distStatus: 'distributed' | 'already_current' | null = distOutcome.required ? distOutcome.distStatus : null;

    if (workingDir) {
      const worktreeCreateBaseBranch = resolveWorktreeCreateBaseBranch(baseBranch, distStatus);

      // Create worktree for isolated branch/file tracking
      let wt: WorktreeInfo;
      try {
        const slug = await this.contentExtractor.generateSlug(task.title);
        // `task.branch` is a PERSISTED value, not fresh API input — a task
        // saved before `rejectQualifiedBranchInput` rejected new
        // fully-qualified refs at the API boundary can still have
        // `branch: 'refs/heads/main'` sitting in the database (Issue #87
        // third-party review, 12th round, Important finding 2). Normalize
        // it the same way `baseBranch` above is normalized, rather than
        // passing it through raw — `assertSafeBranch` inside
        // `WorktreeService.create()` no longer rejects a fully-qualified
        // ref (same review round), so this is about keeping the branch this
        // worktree actually uses/reuses in its plain, unqualified form, not
        // about avoiding a thrown error.
        const branchName = task.branch ? normalizeBranchRef(task.branch) : undefined;
        wt = await this.getWorktreeService(server).create(workingDir, taskId, slug, worktreeCreateBaseBranch, branchName);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.appendLog(taskId, unitId, 'command', {
          type: 'worktree_failed',
          message,
        });
        // 'failed' is deliberately NOT in TOKEN_REVOKING_STATUSES (a failed
        // task is resumable via follow-up onto a later window), so the
        // window-generation token this createWindow() just issued would
        // otherwise leak — revoke it directly, but only once the kill below
        // actually confirms the window is gone (Issue #28 third-party review
        // finding; see TaskPaneEnvironmentService.revokeGeneration's doc
        // comment). Routed through rollbackWindowReference (Issue #28
        // third-party review, second round) so `tmuxWindow` is cleared ONLY
        // once the kill is confirmed — a kill failure leaves the DB row
        // pointing at the still-live, still-authenticated window instead of
        // silently untracking it. Scoped to `tokenId` (the generation
        // createRotatedWindow issued above, inside runExclusiveForTask), not
        // the whole task — a blanket revoke here could otherwise clobber a
        // newer generation a concurrent rotation for this task already
        // persisted (Issue #28 third-party review, WindowRotation.ts finding).
        //
        // Fix 3 (Issue #28 third-party review, Important finding): onGone
        // clears `tmuxWindow` via clearTmuxWindowIfMatches, NOT a blanket
        // `update(taskId, { tmuxWindow: null })` — this whole span (worktree
        // creation + its own rollback) runs OUTSIDE runExclusiveForTask, so a
        // concurrent execute()/followUp() for the SAME task could have
        // already acquired the lock, created a NEWER window generation, and
        // persisted its own `tmuxWindow` by the time this rollback runs. An
        // unconditional null-out would clobber that newer, still-live
        // reference. Gating on `windowName` (this call's own generation)
        // makes the clear a no-op when the row has already moved on — see
        // ITaskRepository.clearTmuxWindowIfMatches's doc comment.
        //
        // Both the status update and the rollback are now
        // rollbackWindowAfterPostCreationFailure() (see its own doc comment)
        // — shared with the worktree_path_rejected branch below and with the
        // fetch-distribution failure branch above.
        await this.rollbackWindowAfterPostCreationFailure(taskId, server, tmuxSession, windowName, tokenId, 'worktree_creation_failed_rollback');
        throw new Error(`Worktree creation failed: ${message}`);
      }

      if (allowedRoot) {
        try {
          // Same TOCTOU fix as above: the resolved path (not wt.path as
          // returned by worktree creation) is what gets persisted and used
          // from here on (Issue #27 review finding 2).
          const resolvedWtPath = await this.assertDirectoryContained(server, { target: wt.path, allowedRoot }, 'worktree path');
          wt = { ...wt, path: resolvedWtPath };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.appendLog(taskId, unitId, 'command', {
            type: 'worktree_path_rejected',
            message,
          });
          // The worktree was already created on disk (and its branch checked
          // out) before this check ran — leaving it behind would leak a real
          // worktree + branch for a task that never got permission to use it
          // (Issue #27 review finding 3). Cleanup failure is logged, not
          // swallowed, since it means the leaked worktree needs manual attention.
          try {
            await this.getWorktreeService(server).remove(workingDir, wt.path);
          } catch (cleanupErr) {
            this.appendLog(taskId, unitId, 'command', {
              type: 'worktree_cleanup_failed',
              message: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
            });
          }
          // Same generation-leak fix as the worktree_failed branch above —
          // see that branch's comment. `tmuxWindow` is cleared inside
          // rollbackWindowReference's onGone callback, not unconditionally
          // above, for the same reason. Scoped to `tokenId`, same reasoning
          // as the worktree_failed branch's rollbackWindowReference call.
          // Fix 3: same clearTmuxWindowIfMatches reasoning as the
          // worktree_failed branch above — this span also runs outside
          // runExclusiveForTask.
          await this.rollbackWindowAfterPostCreationFailure(taskId, server, tmuxSession, windowName, tokenId, 'worktree_path_rejected_rollback', {
            worktreePath: null,
            worktreeBranch: null,
          });
          throw new Error(`Worktree path rejected: ${message}`);
        }
      }

      // Persisted only after the containment check above passes (or is
      // skipped when there's no allowedRoot to check against) — this closes
      // the earlier TOCTOU window where wt.path was written to the DB before
      // it had been verified (Issue #27 review finding 2).
      //
      // task.branch is deliberately NOT written here (Issue #328 review
      // round): it is the value the execution-gate fingerprint hashes as
      // `branches.work` (ExecutionManifest.ts), and it is also read a few
      // lines above as the user-specified branchName input to
      // `getWorktreeService(server).create(...)`. Writing the freshly
      // resolved worktree branch back into it here made an approved-but-
      // unstarted run's OWN worktree creation change the very fingerprint
      // its approval was granted under — the next phase-boundary
      // reverification (PhaseLoopRunner.reverifyExecutionGateForPhase) then
      // saw a manifest that no longer matched and threw the task straight
      // back to pending_approval, mid-run, with the tmux window and worktree
      // already created. `worktreeBranch` is the correct field for "the
      // branch the system actually resolved/created" — it's already in the
      // execution-gate fingerprint's deliberately-excluded list for exactly
      // this self-invalidation reason (see ExecutionManifest.ts's module doc
      // comment).
      this.taskRepo.update(taskId, {
        worktreePath: wt.path,
        worktreeBranch: wt.branch,
        baseBranch,
      } as Partial<Task>);

      this.appendLog(taskId, unitId, 'command', {
        type: 'worktree_created',
        worktreePath: wt.path,
        worktreeBranch: wt.branch,
        baseBranch,
      });

      effectiveDir = wt.path;

      try {
        // effectiveDir is a resolved (symlink-free) real path (see
        // PathContainment.ts) and must be shell-quoted before being typed
        // into the pane — an unquoted realpath can contain shell
        // metacharacters via a maliciously named directory/symlink inside
        // the allowed root (Issue #27 review finding: cd command injection).
        // `--` guards against a leading `-` being read as a cd option.
        await this.tmux.sendKeys(server, target, [`cd -- ${shellQuote(effectiveDir)}`, 'Enter']);
        await sleep(500);
      } catch {}
    }

    // Clean up stale task-owned window rows before adding the new one.
    // Primary rows are always removed (a fresh primary is about to be created).
    // Non-primary rows are removed only when their tmux pane no longer exists.
    for (const w of this.windowRepo.findByTask(taskId)) {
      if (w.ownerType !== 'task') continue;
      if (w.isPrimary) {
        this.windowRepo.remove(w.id);
        continue;
      }
      if (w.sleeping) continue;
      try {
        const alive = await this.tmux.checkPaneExists(server, w.tmuxTarget);
        if (!alive) this.windowRepo.remove(w.id);
      } catch {
        // checkPaneExists failed — keep the row rather than risk deleting a live window
      }
    }

    const windowType = unit.workerType ? 'agent' as const : 'terminal' as const;

    this.windowRepo.add({
      ownerType: 'task',
      projectId: null,
      taskId,
      serverName,
      tmuxTarget: windowTarget,
      label: windowName,
      isPrimary: true,
      windowType,
      workerType: unit.workerType,
      workerModel: unit.workerModel,
      agentSessionId: null,
      launchCommand: buildWorkerLaunchCommand(unit.workerType, unit.workerModel, unit.workerExtraArgs),
      workingDirectory: effectiveDir || null,
      paneLayout: null,
      sleeping: false,
    });

    // Launch worker command
    const workerLaunchCommand = buildWorkerLaunchCommand(unit.workerType, unit.workerModel, unit.workerExtraArgs);
    if (workerLaunchCommand) {
      let effectiveLaunchCommand = workerLaunchCommand;
      const strategy = this.sessionStrategyFactory.create(unit.workerType);
      if (strategy.supportsSession) {
        const sessionId = randomUUID();
        const sessionFlags = strategy.buildNewSessionFlags(sessionId);
        if (sessionFlags) {
          effectiveLaunchCommand = `${workerLaunchCommand} ${sessionFlags}`;
        }
        this.taskRepo.update(taskId, { agentSessionId: sessionId } as Partial<Task>);

        const taskWindows = this.windowRepo.findByTask(taskId);
        const primaryWin = taskWindows.find((w) => w.isPrimary);
        if (primaryWin) {
          this.windowRepo.update(primaryWin.id, { agentSessionId: sessionId });
        }

        if (strategy.needsPostLaunchScan) {
          const scanServer = server;
          const scanWindowRepo = this.windowRepo;
          const scanTaskRepo = this.taskRepo;
          const scanPrimaryWinId = primaryWin?.id;
          (async () => {
            const launchTime = new Date();
            for (let attempt = 0; attempt < 3; attempt++) {
              await sleep(10_000);
              const scannedId = await strategy.scanSessionId(scanServer, effectiveDir ?? null, launchTime).catch(() => null);
              if (scannedId) {
                const assignedW = scanWindowRepo.findAgentSessionIdsByServer(scanServer.name);
                const assignedT = scanTaskRepo.findAgentSessionIdsByServer(scanServer.name);
                if (assignedW.has(scannedId) || assignedT.has(scannedId)) {
                  strategy.excludeSessionId?.(scannedId);
                  continue;
                }
                scanTaskRepo.update(taskId, { agentSessionId: scannedId } as Partial<Task>);
                if (scanPrimaryWinId) {
                  scanWindowRepo.update(scanPrimaryWinId, { agentSessionId: scannedId });
                }
                break;
              }
            }
          })();
        }
      }
      const runtime = this.runtimeRegistry.get(unit.workerRuntime);
      if (shouldSupervise(server.type, windowType)) {
        this.supervisorRegistry.clearExitMarker(server.name, windowTarget);
      }
      try {
        const actualCommand = await runtime.launch({
          server, target, supervisorTarget: windowTarget, taskId, unitId,
          windowType,
          workerExecutionMode: unit.workerExecutionMode,
          effectiveLaunchCommand,
        });
        this.appendLog(taskId, unitId, 'command', { type: 'worker_launch', command: actualCommand });
      } catch {}
    }

    const abortController = new AbortController();
    const executions = this.runningExecutions.get(unitId) || [];
    executions.push({ taskId, abortController, target, windowTarget, serverName });
    this.runningExecutions.set(unitId, executions);
    this.appendLog(taskId, unitId, 'status_change', { status: 'started' });

    const effectiveSelfReviewMax = task.selfReviewMaxAttempts ?? unit.selfReviewMaxAttempts;

    // Issue #87 review (forge/87-mirror follow-up), Important finding 1:
    // resolve the distribution repository ONCE here, against the LOCKED
    // `lockedProject`/`lockedProjectServer` snapshot `performDistribution()`
    // itself distributed against (see their declaration comment above), and
    // pass it into the state machine loop instead of letting it re-derive
    // its own (possibly-since-changed) project/projectServer read — see
    // `PhaseLoopRunner.stateMachineLoop`'s `distributionRepoEntry` parameter
    // doc comment for the full rationale.
    const distributionRepoEntry = resolveExecutionRepositoryEntry(server, lockedProjectServer, lockedProject);
    // Issue #87 review (forge/87-mirror follow-up), Important finding 2
    // (second round): computed against the SAME locked `lockedProjectServer`
    // snapshot as `distributionRepoEntry` above, so PhaseLoopRunner's
    // fail-closed pushing-probe check can never disagree with what was
    // actually true when this run's distribution ran — see
    // `PhaseLoopRunner.stateMachineLoop`'s `distributionRequired` parameter
    // doc comment.
    const distributionRequired = isDistributionRequired(server, lockedProjectServer);

    const runLoop = this.phaseLoopRunner.stateMachineLoop(
      { ...unit, selfReviewMaxAttempts: effectiveSelfReviewMax },
      serverName,
      task,
      server,
      target,
      abortController.signal,
      windowTarget,
      distributionRepoEntry,
      distributionRequired,
    );

    runLoop
      .catch((err: Error) => {
        this.appendLog(taskId, unitId, 'status_change', { status: 'error', message: err.message });
        this.taskRepo.updateStatus(taskId, 'failed');
      })
      .finally(() => {
        const remaining = (this.runningExecutions.get(unitId) || []).filter((e) => e.taskId !== taskId);
        if (remaining.length > 0) {
          this.runningExecutions.set(unitId, remaining);
        } else {
          this.runningExecutions.delete(unitId);
        }

        // Issue #87 review (forge/87-mirror follow-up), Minor finding 3:
        // reuse the SAME `distributionRepoEntry` already resolved above
        // against the fully-locked `lockedProject`/`lockedProjectServer`
        // snapshot, instead of re-deriving it here by mixing
        // `lockedProjectServer` with the pre-lock `project` — a
        // pre-lock/post-lock mismatch could otherwise resolve the final PR
        // reference against a different repository than the one this run
        // actually distributed/pushed to. See `resolveExecutionRepositoryEntry`'s
        // doc comment.
        const repo = distributionRepoEntry ? this.projectRepo.findRepositoryById(distributionRepoEntry.id) : undefined;

        // Collect final git info (changed files + PR URL)
        void (async () => {
          try {
            const currentTask = this.taskRepo.findById(taskId);
            const wtPath = currentTask?.worktreePath;
            const wtBaseBranch = currentTask?.baseBranch;
            const wtBranch = currentTask?.worktreeBranch;
            const ws = this.getWorktreeService(server);

            if (wtPath && await ws.exists(wtPath)) {
              const updates: Partial<Task> = {};
              // worktreeBranch, not branch — same self-invalidation reasoning
              // as the worktree-creation write above: this async tail runs
              // for every completed/failed run of an already-approved task,
              // so writing the resolved branch back into the
              // approval-fingerprinted `branch` field would invalidate the
              // NEXT operation's (e.g. a follow-up's) approval on every
              // ordinary run.
              const branch = await ws.getBranch(wtPath);
              if (branch) updates.worktreeBranch = branch;
              if (wtBaseBranch) {
                const changedFiles = await ws.getDiff(wtPath, wtBaseBranch);
                if (changedFiles) updates.changedFiles = changedFiles;
              }
              const prUrl = await this.findPrUrl(repo, wtBranch ?? null);
              if (prUrl) updates.prUrl = prUrl;
              if (Object.keys(updates).length > 0) {
                this.taskRepo.update(taskId, updates);
              }
            } else if (workingDir) {
              const gitInfo = server.type === 'local'
                ? this.gitInfoCollector.collectGitInfoSync(workingDir, wtBaseBranch ?? undefined)
                : await this.gitInfoCollector.collectGitInfoRemote(server, workingDir, wtBaseBranch ?? undefined);
              const updates: Partial<Task> = {};
              if (gitInfo.changedFiles) updates.changedFiles = gitInfo.changedFiles;
              const prUrl = await this.findPrUrl(repo, gitInfo.branch);
              if (prUrl) updates.prUrl = prUrl;
              // worktreeBranch, not branch — same reasoning as the worktree
              // branch above, applied to the no-worktree fallback path.
              if (gitInfo.branch) updates.worktreeBranch = gitInfo.branch;
              if (Object.keys(updates).length > 0) {
                this.taskRepo.update(taskId, updates);
              }
            }
          } catch {}
        })();
      });
  }

  async followUp(unitId: number, taskId: number, comment: string): Promise<void> {
    const unitForRun = this.unitRepo.findById(unitId);
    if (!unitForRun) throw new Error('Unit not found');

    const task = this.taskRepo.findById(taskId);
    if (!task) throw new Error('Task not found');

    const { serverName, tmuxSession, unit } = this.resolveExecutionEnv(task, unitId);

    const serverAtStart = this.serverRepo.findByName(serverName);
    if (!serverAtStart) throw new Error('Server not found');
    // See the matching comment on execute()'s own `server` declaration for
    // why this is explicitly typed `ServerConfig` rather than inferred.
    let server: ServerConfig = serverAtStart;

    // Same gate as execute() (Issue #328). A follow-up can resume a worker
    // just as much as a fresh execute() can — e.g. a description edit on an
    // untrusted task invalidates its approval hash while the task is
    // mid-run, and the next follow-up (including the one the answer-submit
    // endpoint issues) must not resume it unattended. The `comment` for this
    // particular call is not persisted anywhere and is lost when blocked;
    // the caller must resubmit it after approval (see approve-execution).
    this.enforceExecutionGate(task, unitId, 'resume');

    this.appendLog(taskId, unitId, 'user_comment', { text: comment });
    this.taskRepo.updateStatus(taskId, 'in_progress');

    // Ensure tmux session exists. Same throwaway-bootstrap-window reasoning
    // as execute() above — including the same `isolationMaskForServer`
    // masking (via `ensureSessionWithLock`), not a bare `{}` and not
    // `uiTokenEnvForServer` — since the real task window (created just
    // below, if it doesn't already exist) is what actually gets
    // AZITO_TASK_TOKEN.
    //
    // Routed through ensureSessionWithLock (Issue #29 review, 10th pass,
    // Critical finding 1) — same fix as execute() above: the existence
    // check and createSession both now run inside the isolation lock
    // against a freshly re-read `server`, and `server` is reassigned to
    // that fresh row for everything followUp() does afterwards. (This is
    // still logically separate from the per-task rotation lock below —
    // session bootstrap is idempotent/harmless to race against another
    // task's window creation on the same server/session — it is now
    // serialized only against the isolation transition, via the
    // per-server-name mutex, not against runExclusiveForTask.)
    let sessionResult: { created: boolean; server: ServerConfig };
    try {
      sessionResult = await ensureSessionWithLock(this.tmux, this.serverIsolationLock, server, tmuxSession);
    } catch (err) {
      this.failOnServerSnapshotMismatch(err, taskId, unitId);
      throw err;
    }
    server = sessionResult.server;
    if (sessionResult.created) {
      await sleep(500);
    }

    // Threaded to the working-directory-rejected rollback below (needs the
    // specific generation to revoke — see that branch's comment); stays null
    // when the `windowExists` result is true, since nothing was rotated.
    let windowName: string;
    let windowExists: boolean;
    let tokenId: number | null;
    let createdServer: ServerConfig;
    try {
      // The ENTIRE "read current window state -> decide whether to rotate ->
      // create -> persist" sequence now runs inside runExclusiveForTask, not
      // just the create/persist half (Issue #28 third-party review, TOCTOU
      // finding): the old code computed `windowExists` from a `task`/tmux
      // snapshot taken BEFORE the lock. Two concurrent follow-ups for the
      // same not-yet-running task could both observe "no window yet" from
      // their own pre-lock snapshot, both enter the rotation, and the
      // second's issueNextGeneration() would revoke the first's
      // still-being-created generation before its window creation even
      // resolved — runExclusiveForTask only serializes the callbacks, it
      // doesn't protect state read before either callback started. Reading
      // `task.tmuxWindow` fresh from the repository INSIDE the lock, and
      // re-checking tmux for it there too, means the decision is always made
      // against the latest state any prior queued rotation for this task
      // (execute()/followUp()/respawn()) actually persisted.
      ({ windowName, windowExists, tokenId, server: createdServer } = await runExclusiveForTask(taskId, async () => {
        const currentTask = this.taskRepo.findById(taskId);
        if (!currentTask) throw new Error(`Task ${taskId} not found`);
        const candidateWindowName = currentTask.tmuxWindow || `task-${task.id}`;
        let exists = false;
        try {
          const sessions = await this.tmux.listSessions(server);
          const session = sessions.find((s) => s.name === tmuxSession);
          if (session) exists = session.windows.some((w) => w.name === candidateWindowName);
        } catch {}
        if (exists) {
          return { windowName: candidateWindowName, windowExists: true, tokenId: null, server };
        }

        // Window generation point for a follow-up that has no window to
        // resume onto — rotates the task token, same as execute() above. A
        // follow-up onto an ALREADY-existing window (the common case) never
        // reaches this branch at all, matching design v3 §2's "resume onto
        // an existing window never rotates". No old window to kill here
        // (exists is false), so unlike execute() this only needs the
        // create-failure rollback half of the shared operation —
        // createRotatedWindow revokes the freshly-issued generation whether
        // creation throws or resolves with a non-zero exit code (Issue #28
        // third-party review, followUp() rollback-safety finding; see
        // WindowRotation.ts's doc comment). The DB is only updated with
        // `windowName` once creation is confirmed to have actually
        // succeeded.
        const created = await createRotatedWindow(this.paneEnvService, this.serverIsolationLock, server, currentTask, 'followup_create_failed', (freshServer, env) =>
          this.tmux.createWindow(freshServer, tmuxSession, `task-${task.id}`, { extraEnv: env }),
          true,
          (fs) => this.reverifyGateInLock(currentTask, unitId, 'resume', fs),
        );
        this.taskRepo.update(taskId, { tmuxWindow: created.windowName } as Partial<Task>);
        return { windowName: created.windowName, windowExists: false, tokenId: created.tokenId, server: created.server };
      }));
    } catch (err) {
      if (this.failOnServerSnapshotMismatch(err, taskId, unitId)) throw err;
      // Issue #29 Step 3a review, Important finding 2: see the matching
      // comment in execute() above — reverifyGateInLock's errors must not be
      // swallowed into the generic wrap below.
      if (err instanceof ExecutionGateDeniedError || err instanceof ExecutionGatePendingApprovalError) throw err;
      throw new Error(`Failed to create tmux window: ${err instanceof Error ? err.message : err}`);
    }
    // Issue #29 review (10th pass), Important finding 3: use the fresh
    // `server` row the lock actually ran against (either the "window
    // already exists" branch's own re-check, or createRotatedWindow's
    // refetch) for everything followUp() does past this point.
    server = createdServer;

    const windowTarget = `${tmuxSession}:${windowName}`;
    const target = await this.tmux.resolvePaneId(server, windowTarget);

    if (!windowExists) {
      // Use worktree path if available, otherwise fall back to working directory.
      // Neither field is trusted just because it resolves/exists on disk: both
      // task.worktreePath and task.workingDirectory are settable via
      // PUT /api/tasks/:id, so without the containment check below a caller
      // could simply walk around the boundary execute() enforces by editing
      // the task and then triggering a follow-up instead of a fresh execute()
      // (Issue #27 review finding 1).
      const followUpProject = this.projectRepo.findById(task.projectId);
      const followUpProjectServerForDir = followUpProject ? this.projectServerRepo.find(task.projectId, serverName) : null;
      const followUpAllowedRoot = followUpProjectServerForDir?.workingDirectory || null;
      let followUpDir = task.worktreePath && await this.getWorktreeService(server).exists(task.worktreePath)
        ? task.worktreePath
        : (task.workingDirectory || followUpProjectServerForDir?.workingDirectory);

      if (followUpDir && followUpAllowedRoot) {
        try {
          // Use the resolved path for the `cd` below, same TOCTOU fix as
          // execute() (Issue #27 review finding 2).
          followUpDir = await this.assertDirectoryContained(server, { target: followUpDir, allowedRoot: followUpAllowedRoot }, 'follow-up working directory');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.appendLog(taskId, unitId, 'command', { type: 'working_directory_rejected', message });
          this.taskRepo.update(taskId, { status: 'failed' as TaskStatus } as Partial<Task>);
          // Same generation-leak fix as execute()'s worktree_failed branch
          // above — this branch only runs when !windowExists just created a
          // fresh window (and rotated the task token, so `tokenId` is
          // non-null here) for this follow-up. `tmuxWindow` is cleared
          // inside rollbackWindowReference's onGone callback, not
          // unconditionally above, for the same reason. Scoped to `tokenId`,
          // same reasoning as execute()'s rollbackWindowReference calls.
          // Fix 3 (Issue #28 third-party review, Important finding): same
          // clearTmuxWindowIfMatches reasoning as execute()'s
          // rollbackWindowReference calls — this span also runs outside
          // runExclusiveForTask.
          try {
            await rollbackWindowReference(
              this.tmux.killWindow(server, `${tmuxSession}:${windowName}`),
              this.paneEnvService,
              tokenId!,
              'followup_working_directory_rejected_rollback',
              () => this.taskRepo.clearTmuxWindowIfMatches(taskId, windowName),
              () => {},
            );
          } catch {}
          throw new Error(`Follow-up working directory rejected: ${message}`);
        }
      }

      if (followUpDir) {
        try {
          await this.tmux.sendKeys(server, target, [`cd -- ${shellQuote(followUpDir)}`, 'Enter']);
          await sleep(500);
        } catch {}
      }

      const followUpLaunchCommand = buildWorkerLaunchCommand(unit.workerType, unit.workerModel, unit.workerExtraArgs);
      if (followUpLaunchCommand) {
        let effectiveFollowUpCommand = followUpLaunchCommand;
        if (task.agentSessionId) {
          const followUpStrategy = this.sessionStrategyFactory.create(unit.workerType);
          if (followUpStrategy.supportsSession) {
            const sessionFlags = followUpStrategy.buildResumeFlags(task.agentSessionId);
            if (sessionFlags) {
              effectiveFollowUpCommand = `${followUpLaunchCommand} ${sessionFlags}`;
            }
          }
        }
        const runtime = this.runtimeRegistry.get(unit.workerRuntime);
        const primaryWin = this.windowRepo.findByTask(taskId).find((w) => w.isPrimary);
        const followUpWindowType = primaryWin?.windowType ?? 'terminal';
        if (shouldSupervise(server.type, followUpWindowType)) {
          this.supervisorRegistry.clearExitMarker(server.name, windowTarget);
        }
        try {
          const actualCommand = await runtime.resume({
            server, target, supervisorTarget: windowTarget, taskId, unitId,
            windowType: followUpWindowType,
            workerExecutionMode: unit.workerExecutionMode,
            effectiveLaunchCommand: effectiveFollowUpCommand,
          });
          this.appendLog(taskId, unitId, 'command', { type: 'worker_launch', command: actualCommand });
        } catch {}
      }
    }

    const abortController = new AbortController();
    const followUpExecutions = this.runningExecutions.get(unitId) || [];
    followUpExecutions.push({ taskId, abortController, target, windowTarget, serverName });
    this.runningExecutions.set(unitId, followUpExecutions);
    this.appendLog(taskId, unitId, 'status_change', { status: 'follow_up_started', comment });

    const runFollowUp = async () => {
      // Generate unique markers for follow-up
      // crypto.randomBytes (not Math.random) — the nonce is also embedded in
      // turnToken (design v3 §8), which /api/agent-signals now accepts as a
      // standalone credential, so it must not be predictable.
      const nonce = randomBytes(16).toString('hex');
      const doneMarker = `AZITO_DONE_${taskId}_${nonce}`;
      const questionsMarker = `AZITO_QUESTIONS_${taskId}_${nonce}`;
      const testFailedMarker = `AZITO_TEST_FAILED_${taskId}_${nonce}`;
      const outputFilePath = `/tmp/azito-output-${taskId}-${nonce}.md`;
      const httpSignalMode = usesHttpSignalPath(unit.workerExecutionMode);

      // Start pipe-pane BEFORE sending to capture all output — this capture runs
      // in BOTH execution modes (see PhaseLoopRunner.stateMachineLoop's identical note).
      const followUpStream = this.workerWaiter.startPaneStream(server, target, taskId, unitId);
      if (!followUpStream) return;

      const followUpProject = this.projectRepo.findById(task.projectId);
      const followUpProjectServer = followUpProject ? this.projectServerRepo.find(task.projectId, serverName) : null;
      const followUpCurrentTask = this.taskRepo.findById(taskId);
      const followUpVars = {
        task: {
          title: task.title,
          description: task.description || '',
          plan: followUpCurrentTask?.planMarkdown || '',
          targetBranch: followUpCurrentTask?.targetBranch
            ? `- PR target branch: ${followUpCurrentTask.targetBranch} (if this branch does not exist, create it from ${followUpCurrentTask.baseBranch || followUpProject?.defaultBranch || 'main'} before creating the PR)`
            : '',
          pushTaskDescription: followUpCurrentTask?.skipPr
            ? 'Push the implementation. Do NOT create a new Pull Request.\nOnly commit and push the changes. If a PR already exists for this branch, update its title and body to reflect the changes.'
            : 'Push the implementation and create a Pull Request.',
          pushRules: followUpCurrentTask?.skipPr
            ? ''
            : '- PR title should concisely describe the task\n- PR body should include a summary of changes and test results',
          pushOutput: followUpCurrentTask?.skipPr
            ? 'Report the branch name that was pushed.'
            : 'Report the PR URL.',
        },
        project: {
          sidekickPrompt: [followUpProject?.sidekickPrompt, unit.systemPrompt].filter(Boolean).join('\n\n'),
          defaultBranch: followUpCurrentTask?.baseBranch || followUpProject?.defaultBranch || 'main',
        },
        projectServer: {
          workingDirectory: followUpCurrentTask?.workingDirectory || followUpProjectServer?.workingDirectory || '.',
          branch: followUpProjectServer?.branch || '',
        },
        selfReview: {
          attempt: '1',
          maxAttempts: String(task.selfReviewMaxAttempts ?? unit.selfReviewMaxAttempts),
        },
      };
      const expandedComment = expandTemplate(comment, followUpVars, true);

      // Start signal stream for completion detection: a tmux pipe-pane signal
      // file, or (http-signal mode) an in-process AgentTurn subscription — same
      // branch as PhaseLoopRunner.stateMachineLoop (Issue: AZITO監視強化 Phase 1).
      // follow-up has no fixed TaskPhase of its own; both branches cover this
      // via `phase: null`/`'follow_up'` (see executionEnvelope.ts).
      const runtime = this.runtimeRegistry.get(unit.workerRuntime);
      const envelopeResult = runtime.buildFollowUpEnvelope({
        nonce, taskId, unitId, workerExecutionMode: unit.workerExecutionMode,
        server, target, supervisorTarget: windowTarget, prompt: expandedComment, outputFilePath,
        doneMarker, questionsMarker, testFailedMarker,
      });
      const followUpSignalStream = envelopeResult.signalStream;
      const commentWithMarkers = envelopeResult.markerizedPrompt;
      let httpSignalTurn = envelopeResult.httpSignalTurn;

      this.appendLog(taskId, unitId, 'command', { type: 'follow_up_prompt', text: commentWithMarkers, doneMarker, questionsMarker });

      // For non-LLM modes: send the comment with marker instructions to the worker
      // (supervisor PTY when supervised+connected, tmux send-keys otherwise —
      // see WorkerInputService)
      try {
        await runtime.sendPrompt({ server, target, supervisorTarget: windowTarget, taskId, unitId }, commentWithMarkers);
      } catch (err: unknown) {
        followUpStream.stop();
        followUpSignalStream.stop();
        this.appendLog(taskId, unitId, 'status_change', { status: 'send_error', message: (err as Error).message });
        this.taskRepo.updateStatus(taskId, 'failed');
        return;
      }

      const waitResult = await this.workerWaiter.waitForWorker(server, target, taskId, unitId, abortController.signal, followUpStream, doneMarker, followUpSignalStream, undefined, windowTarget);
      const output = waitResult.output;
      let classification = waitResult.classification;
      let httpSignalFinalTurn = httpSignalTurn;
      if (httpSignalMode && httpSignalTurn) {
        const finalized = await this.httpSignalCoordinator.finalize(httpSignalTurn.id, classification, abortController.signal.aborted);
        classification = finalized.classification;
        httpSignalFinalTurn = finalized.turn;
      }

      if (classification.status === 'question') {
        this.appendLog(taskId, unitId, 'output', output);
        this.taskRepo.update(taskId, { pendingQuestions: JSON.stringify(classification.questions || []) } as Partial<Task>);
        this.appendLog(taskId, unitId, 'status_change', { status: 'waiting_for_human', question: output });
        this.taskRepo.updateStatus(taskId, 'waiting_input');
        return;
      }

      // Handle phase_complete during planning: extract plan and go to phase_review
      // Use task.currentPhase (original at followUp entry) for phase resolution, not DB status
      // (DB was updated to in_progress at entry, losing the original phase context)
      const origCurrentPhase = task.currentPhase;
      if (classification.status === 'phase_complete') {
        const followUpPhaseOutput = httpSignalMode && httpSignalFinalTurn
          ? this.httpSignalCoordinator.readOutput(httpSignalFinalTurn.id) ?? await this.workerWaiter.readPhaseOutputFile(server, outputFilePath)
          : await this.workerWaiter.readPhaseOutputFile(server, outputFilePath);
        if (followUpPhaseOutput !== null) {
          this.appendLog(taskId, unitId, 'command', { type: 'phase_output_read', length: followUpPhaseOutput.length });
        } else {
          this.appendLog(taskId, unitId, 'command', { type: 'phase_output_missing' });
        }
        this.appendLog(taskId, unitId, 'output', followUpPhaseOutput !== null ? followUpPhaseOutput : output);

        const currentTask = this.taskRepo.findById(taskId);
        const ut = origCurrentPhase ? this.unitTypeLoader.get(unit.unitType) : null;
        const followUpPhaseDef = ut?.phases.find((p) => p.name === origCurrentPhase);
        if (followUpPhaseDef?.planApproval) {
          const planMarkdown = followUpPhaseOutput !== null
            ? followUpPhaseOutput
            : await this.workerWaiter.extractPlanWithFallback(server, target, output);
          if (planMarkdown) {
            this.taskRepo.update(taskId, { planMarkdown } as Partial<Task>);
          }
          if (currentTask?.requirePlanApproval) {
            this.appendLog(taskId, unitId, 'status_change', { status: 'phase_review', planOutput: followUpPhaseOutput !== null ? followUpPhaseOutput : output });
            this.taskRepo.updateStatus(taskId, 'phase_review');
            return;
          }
        }
      } else {
        this.appendLog(taskId, unitId, 'output', output);
      }

      // Resume the phase flow after follow-up when the original currentPhase maps to a known phase.
      if (origCurrentPhase) {
        const ut = this.unitTypeLoader.get(unit.unitType);
        const phaseNames = ut ? ut.phases.map((p) => p.name) : [];
        if (phaseNames.includes(origCurrentPhase)) {
          const effectiveSelfReviewMax = task.selfReviewMaxAttempts ?? unit.selfReviewMaxAttempts;
          // Issue #87 review follow-up, Important finding 2: must apply the
          // SAME "recorded distribution repository is authoritative, fail
          // closed if it no longer resolves" rule resumeStateMachine() does
          // — this follow-up continuation resumes the exact same
          // already-distributed working directory a plan-approval wait or a
          // startup recovery would resume via resumeStateMachine(), so it
          // cannot re-resolve from `followUpProject`/`followUpProjectServer`'s
          // CURRENT configuration either. See
          // `resolveRecordedDistributionRepositoryEntry`'s doc comment.
          const followUpResolution = resolveRecordedDistributionRepositoryEntry(task.distributionRepositoryId, server, followUpProjectServer, followUpProject);
          if (!followUpResolution.ok) {
            this.appendLog(taskId, unitId, 'status_change', {
              status: 'error',
              message: `This task's recorded distribution repository (id ${followUpResolution.recordedRepositoryId}) no longer exists — refusing to resume with a different repository`,
            });
            this.taskRepo.updateStatus(taskId, 'failed');
            return;
          }
          const followUpDistributionRepoEntry = followUpResolution.entry;
          // Issue #87 review (forge/87-mirror follow-up), Important finding
          // 2 (third round): a recorded `task.distributionRepositoryId` is
          // itself proof this task was distributed, regardless of what the
          // CURRENT `followUpProjectServer` configuration now says — see
          // `isDistributionRequiredForContinuation`'s doc comment. Computed
          // against the SAME `followUpProjectServer` snapshot used to
          // resolve `followUpResolution` above, so PhaseLoopRunner's
          // fail-closed pushing-probe check agrees with what this follow-up
          // continuation actually resolved — see
          // `PhaseLoopRunner.stateMachineLoop`'s `distributionRequired`
          // parameter doc comment.
          const followUpDistributionRequired = isDistributionRequiredForContinuation(task.distributionRepositoryId, server, followUpProjectServer);
          await this.phaseLoopRunner.stateMachineLoop({ ...unit, selfReviewMaxAttempts: effectiveSelfReviewMax }, serverName, { ...task, currentPhase: origCurrentPhase }, server, target, abortController.signal, windowTarget, followUpDistributionRepoEntry, followUpDistributionRequired);
          return;
        }
      }

      this.taskRepo.updateStatus(taskId, 'review');
    };

    runFollowUp()
      .catch((err: Error) => {
        this.appendLog(taskId, unitId, 'status_change', { status: 'error', message: err.message });
        this.taskRepo.updateStatus(taskId, 'failed');
      })
      .finally(() => {
        const remainingFollowUp = (this.runningExecutions.get(unitId) || []).filter((e) => e.taskId !== taskId);
        if (remainingFollowUp.length > 0) {
          this.runningExecutions.set(unitId, remainingFollowUp);
        } else {
          this.runningExecutions.delete(unitId);
        }
      });
  }

  async resumeStateMachine(unitId: number, taskId: number): Promise<void> {
    const unitForRun = this.unitRepo.findById(unitId);
    if (!unitForRun) throw new Error('Unit not found');

    const task = this.taskRepo.findById(taskId);
    if (!task) throw new Error('Task not found');

    const { serverName, tmuxSession, unit } = this.resolveExecutionEnv(task, unitId);

    const server = this.serverRepo.findByName(serverName);
    if (!server) throw new Error('Server not found');

    // Same gate as execute()/followUp() (Issue #328). Reached from
    // approve-plan's "resume from implementing" flow and from startup
    // recovery (RecoverStuckTasksUseCase) — both resume a worker that may
    // have gone stale for an untrusted task (description edited since the
    // approval this run started under).
    this.enforceExecutionGate(task, unitId, 'resume');

    // Validate currentPhase against unitType phases
    if (task.currentPhase) {
      const ut = this.unitTypeLoader.getOrThrow(unit.unitType);
      const phaseNames = ut.phases.map((p) => p.name);
      if (!phaseNames.includes(task.currentPhase)) {
        this.appendLog(taskId, unitId, 'status_change', { status: 'error', message: `currentPhase "${task.currentPhase}" not found in unitType "${unit.unitType}"` });
        this.taskRepo.updateStatus(taskId, 'failed');
        throw new Error(`currentPhase "${task.currentPhase}" not found in unitType "${unit.unitType}"`);
      }
    }

    const windowName = task.tmuxWindow || `task-${task.id}`;
    const windowTarget = `${tmuxSession}:${windowName}`;
    const target = await this.tmux.resolvePaneId(server, windowTarget);

    const abortController = new AbortController();
    const executions = this.runningExecutions.get(unitId) || [];
    executions.push({ taskId, abortController, target, windowTarget, serverName });
    this.runningExecutions.set(unitId, executions);

    const effectiveSelfReviewMax = task.selfReviewMaxAttempts ?? unit.selfReviewMaxAttempts;

    // Issue #87 review follow-up, Important finding 1: a resumed run must
    // NEVER re-resolve the distribution target from the project/project-
    // server's CURRENT configuration — the task's working directory already
    // holds code from whichever repository distribution actually pulled it
    // from at execute() time (or restore() time), and that can differ from
    // `projectServer.distributionRepositoryId` by the time a plan-approval
    // wait, or a startup recovery, gets around to calling resumeStateMachine
    // (an operator can repoint the project server's distribution target at
    // repository B while a task's worktree still holds repository A's code
    // mid-run). See `Task.distributionRepositoryId`'s doc comment.
    const resumeProject = this.projectRepo.findById(task.projectId);
    const resumeProjectServer = resumeProject ? this.projectServerRepo.find(task.projectId, serverName) : null;
    // Shared with followUp()'s state-machine continuation and
    // isPushCompleted() (Issue #87 review follow-up, Important findings 2 &
    // 3) — see `resolveRecordedDistributionRepositoryEntry`'s doc comment
    // for the full "recorded value is authoritative, fail closed if it no
    // longer resolves" rule.
    const resumeResolution = resolveRecordedDistributionRepositoryEntry(task.distributionRepositoryId, server, resumeProjectServer, resumeProject);
    if (!resumeResolution.ok) {
      this.appendLog(taskId, unitId, 'status_change', {
        status: 'error',
        message: `This task's recorded distribution repository (id ${resumeResolution.recordedRepositoryId}) no longer exists — refusing to resume with a different repository`,
      });
      this.taskRepo.updateStatus(taskId, 'failed');
      return;
    }
    const resumeDistributionRepoEntry: ProjectRepositoryEntry | null = resumeResolution.entry;
    // Issue #87 review (forge/87-mirror follow-up), Important finding 2
    // (third round): a recorded `task.distributionRepositoryId` is itself
    // proof this task was distributed, regardless of what the CURRENT
    // `resumeProjectServer` configuration now says — see
    // `isDistributionRequiredForContinuation`'s doc comment. Computed
    // against the SAME `resumeProjectServer` snapshot used to resolve
    // `resumeResolution` above, so PhaseLoopRunner's fail-closed
    // pushing-probe check agrees with what this resume actually resolved —
    // see `PhaseLoopRunner.stateMachineLoop`'s `distributionRequired`
    // parameter doc comment.
    const resumeDistributionRequired = isDistributionRequiredForContinuation(task.distributionRepositoryId, server, resumeProjectServer);

    this.phaseLoopRunner.stateMachineLoop(
      { ...unit, selfReviewMaxAttempts: effectiveSelfReviewMax },
      serverName,
      { ...task },
      server,
      target,
      abortController.signal,
      windowTarget,
      resumeDistributionRepoEntry,
      resumeDistributionRequired,
    )
      .catch((err: Error) => {
        this.appendLog(taskId, unitId, 'status_change', { status: 'error', message: err.message });
        this.taskRepo.updateStatus(taskId, 'failed');
      })
      .finally(() => {
        const remaining = (this.runningExecutions.get(unitId) || []).filter((e) => e.taskId !== taskId);
        if (remaining.length > 0) {
          this.runningExecutions.set(unitId, remaining);
        } else {
          this.runningExecutions.delete(unitId);
        }
      });
  }

  stop(unitId: number, taskId?: number): boolean {
    const executions = this.runningExecutions.get(unitId);
    if (!executions || executions.length === 0) return false;
    if (taskId !== undefined) {
      const exec = executions.find((e) => e.taskId === taskId);
      if (!exec) return false;
      exec.abortController.abort();
    } else {
      for (const exec of executions) {
        exec.abortController.abort();
      }
    }
    return true;
  }

  stopByTaskId(taskId: number): boolean {
    for (const [, executions] of this.runningExecutions) {
      const exec = executions.find((e) => e.taskId === taskId);
      if (exec) {
        exec.abortController.abort();
        return true;
      }
    }
    return false;
  }

  /** Backing data for GET /api/operations (running execution runs), keyed by unitId. */
  getRunning(): Record<number, Array<{ taskId: number; target: string; serverName: string }>> {
    const result: Record<number, Array<{ taskId: number; target: string; serverName: string }>> = {};
    for (const [id, executions] of this.runningExecutions) {
      result[id] = executions.map((e) => ({ taskId: e.taskId, target: e.windowTarget, serverName: e.serverName }));
    }
    return result;
  }

  async isPushCompleted(taskId: number): Promise<boolean> {
    const task = this.taskRepo.findById(taskId);
    if (!task) return false;
    const project = this.projectRepo.findById(task.projectId);
    // Same Unit resolution as resolveExecutionEnv (task.unitId ?? project.defaultUnitId):
    // a task governed only by the project default Unit is still a real execution.
    const resolvedUnitId = resolveUnitId(task, project);
    if (resolvedUnitId === null) return false;
    const resolvedServerName = resolveTaskServerName(task, this.projectServerRepo);
    if (!resolvedServerName) return false;
    const server = this.serverRepo.findByName(resolvedServerName);
    if (!server) return false;
    const ps = project ? this.projectServerRepo.find(task.projectId, resolvedServerName) : null;
    const workingDir = task.workingDirectory || ps?.workingDirectory;
    if (!workingDir) return false;
    const branch = task.worktreeBranch || task.branch || '';
    if (!branch) return false;
    // Issue #87 review follow-up, Important finding 3: must use the task's
    // RECORDED distribution repository when one exists (same rule
    // resumeStateMachine()/followUp() apply), not re-resolve from `ps`/
    // `project`'s current configuration — a working tree distributed from
    // repository A must never have its push/PR verified against repository
    // B just because the project server's config changed while the task was
    // pushing. Fails closed (never calls PR creation/verification) when the
    // recorded value no longer resolves. A task with no recorded value
    // (predates this column, or never went through distribution) falls back
    // to `resolveExecutionRepositoryEntry`'s live resolution unchanged. See
    // `resolveRecordedDistributionRepositoryEntry`'s doc comment.
    const repoResolution = resolveRecordedDistributionRepositoryEntry(task.distributionRepositoryId, server, ps, project);
    if (!repoResolution.ok) return false;
    const repoEntry2 = repoResolution.entry;
    const repo = repoEntry2 ? this.projectRepo.findRepositoryById(repoEntry2.id) : null;
    // Issue #87 review finding (Important), shared with PhaseLoopRunner's
    // pushing-phase probe via `isDistributionRequiredButRepositoryUnresolved`
    // (see its doc comment for the full fail-closed rationale) — must fail
    // fast here too, never fall through into `PushVerifier`'s
    // no-repo-info-registered fallback. Uses `isDistributionRequiredForContinuation`
    // (Issue #87 review, forge/87-mirror follow-up, Important finding 2,
    // third round) so a recorded `task.distributionRepositoryId` alone still
    // forces this closed even if the CURRENT `ps` configuration no longer
    // calls for distribution. Computed against the SAME `ps` snapshot used
    // to resolve `repoResolution` above so this check can never disagree
    // with what this call actually resolved.
    if (isDistributionRequiredButRepositoryUnresolved(isDistributionRequiredForContinuation(task.distributionRepositoryId, server, ps), repo)) return false;
    if (!task.skipPr) {
      await this.pullRequestCreator.ensureCreated(task.id, resolvedUnitId, repo, branch, {
        title: task.title,
        description: task.description,
        targetBranch: task.targetBranch,
      });
    }
    return this.pushVerifier.verifyPushCompleted(server, workingDir, branch, task.skipPr, repo);
  }
}
