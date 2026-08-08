import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { ITaskRepository, Task } from '../Task';
import type { TaskStatus } from '../TaskStatus';
import type { IUnitRepository, Unit } from '../../units/Unit';
import { usesHttpSignalPath } from '../../units/Unit';
import type { IServerRepository } from '../../servers/Server';
import type { IProjectRepository } from '../../projects/Project';
import type { IProjectServerRepository } from '../../projects/ProjectServer';
import type { SqliteProjectSecretRepository } from '../../projects/SqliteProjectSecretRepository';
import type { SidekickPackageLoader } from '../../sidekicks/SidekickPackageLoader';
import type { SidekickSyncService } from '../../sidekicks/SidekickSyncService';
import type { IExecutionLogRepository, LogType } from '../ExecutionLog';
import type { TmuxClient } from '../../tmux/TmuxClient';
import { resolveKillOutcome } from '../../tmux/killOutcome';
import type { IWorktreeService, WorktreeInfo } from '../../git/IWorktreeService';
import type { WorktreeServiceFactory } from '../../git/WorktreeServiceFactory';
import { PathResolverFactory, assertDirectoryContained } from '../../git/PathContainment';
import type { GitProviderService } from '../../git/providers/GitProviderService';
import type { ProjectRepositoryWithToken as ProjectRepository } from '../../projects/Project';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import type { ServerConfig } from '../../servers/Server';
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
import { checkExecutionGate, ExecutionGateDeniedError, ExecutionGatePendingApprovalError } from './ExecutionGate';
import { resolveExecutionManifest, hashExecutionManifest } from './ExecutionManifest';
import { TuiWorkerRuntime } from './runtime/TuiWorkerRuntime';
import { WorkerRuntimeRegistry } from './runtime/WorkerRuntimeRegistry';
import { resolveTaskServerName, resolveTmuxSession, resolveUnitId, resolveBaseBranch } from './TaskExecutionEnv';
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
    const tuiRuntime = new TuiWorkerRuntime(this.tmux, this.workerInput, this.workerWaiter, this.httpSignalCoordinator);
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
    );
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
    const { manifest, project, projectServer } = resolveExecutionManifest(task, {
      unitRepo: this.unitRepo,
      projectRepo: this.projectRepo,
      projectServerRepo: this.projectServerRepo,
      serverRepo: this.serverRepo,
      projectSecretRepo: this.projectSecretRepo,
      unitTypeLoader: this.unitTypeLoader,
      sidekickLoader: this.sidekickLoader,
    });
    const manifestHash = hashExecutionManifest(manifest);
    const gate = checkExecutionGate(task, projectServer, manifestHash);
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

  private appendLog(taskId: number, unitId: number, type: LogType, content: unknown): void {
    appendLogAndEmit(this.logRepo, this.events, taskId, unitId, type, content);
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

    const server = this.serverRepo.findByName(serverName);
    if (!server) throw new Error('Server not found');

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
    // window created below — it deliberately gets no env at all (no task
    // token, no UI token) rather than issuing/rotating a token for a window
    // nobody uses.
    const existingSessions = await this.tmux.listSessions(server);
    const sessionExists = existingSessions.some((s) => s.name === tmuxSession);
    if (!sessionExists) {
      await this.tmux.createSession(server, tmuxSession, { extraEnv: {} });
      await sleep(500);
    }

    // Kill existing task window if leftover
    if (task.tmuxWindow) {
      try {
        const preCheck = await this.tmux.listSessions(server);
        const preSession = preCheck.find((s) => s.name === tmuxSession);
        if (preSession) {
          const oldWin = preSession.windows.find((w) => w.name === task.tmuxWindow);
          if (oldWin) {
            await this.tmux.killPane(server, `${tmuxSession}:${oldWin.index}`);
            await sleep(300);
          }
        }
      } catch {}
    }

    // Create a new tmux window for the task — this call is the actual
    // window-generation point, so it's the one that rotates the task token
    // (TaskPaneEnvironmentService.buildEnvForNewWindow; design v3 §2).
    let windowName: string;
    try {
      const created = await this.tmux.createWindow(server, tmuxSession, `task-${task.id}`, { extraEnv: this.paneEnvService.buildEnvForNewWindow(task, server) });
      windowName = created.windowName;
    } catch (err) {
      throw new Error(`Failed to create tmux window: ${err instanceof Error ? err.message : err}`);
    }

    this.taskRepo.update(taskId, { status: 'in_progress' as TaskStatus, tmuxWindow: windowName });

    const windowTarget = `${tmuxSession}:${windowName}`;
    const target = await this.tmux.resolvePaneId(server, windowTarget);

    if (workingDir) {
      // Create worktree for isolated branch/file tracking
      let wt: WorktreeInfo;
      const baseBranch = resolveBaseBranch(task, projectServer, project);
      try {
        const slug = await this.contentExtractor.generateSlug(task.title);
        wt = await this.getWorktreeService(server).create(workingDir, taskId, slug, baseBranch, task.branch || undefined);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.appendLog(taskId, unitId, 'command', {
          type: 'worktree_failed',
          message,
        });
        this.taskRepo.update(taskId, { status: 'failed' as TaskStatus, tmuxWindow: null } as Partial<Task>);
        // 'failed' is deliberately NOT in TOKEN_REVOKING_STATUSES (a failed
        // task is resumable via follow-up onto a later window), so the
        // window-generation token this createWindow() just issued would
        // otherwise leak — revoke it directly, but only once the kill below
        // actually confirms the window is gone (Issue #28 third-party review
        // finding; see TaskPaneEnvironmentService.revokeForDestroyedWindow's
        // doc comment).
        try {
          // resolveKillOutcome normalizes local (throws on failure) vs agent
          // (resolves with a non-zero code) transports into one verdict —
          // only revoke the generation once the kill actually confirms the
          // window is gone (Issue #28 third-party review finding 2: a bare
          // await here previously treated an agent-transport kill failure as
          // success and revoked anyway, leaving a still-live pane holding a
          // dead credential).
          const outcome = await resolveKillOutcome(this.tmux.killWindow(server, `${tmuxSession}:${windowName}`));
          if (outcome.success) {
            this.paneEnvService.revokeForDestroyedWindow(taskId, 'worktree_creation_failed_rollback');
          }
        } catch {}
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
          this.taskRepo.update(taskId, {
            status: 'failed' as TaskStatus,
            tmuxWindow: null,
            worktreePath: null,
            worktreeBranch: null,
          } as Partial<Task>);
          // Same generation-leak fix as the worktree_failed branch above —
          // see that branch's comment.
          try {
            // See the worktree_creation_failed_rollback branch above for why
            // this checks resolveKillOutcome's verdict before revoking.
            const outcome = await resolveKillOutcome(this.tmux.killWindow(server, `${tmuxSession}:${windowName}`));
            if (outcome.success) {
              this.paneEnvService.revokeForDestroyedWindow(taskId, 'worktree_path_rejected_rollback');
            }
          } catch {}
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
      tmuxTarget: `${windowTarget}.1`,
      label: windowName,
      isPrimary: true,
      windowType,
      workerType: unit.workerType,
      workerModel: unit.workerModel,
      agentSessionId: null,
      launchCommand: buildWorkerLaunchCommand(unit.workerType, unit.workerModel, unit.workerExtraArgs),
      workingDirectory: effectiveDir || null,
      paneLayout: null,
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
    executions.push({ taskId, abortController, target, windowTarget: `${windowTarget}.1`, serverName });
    this.runningExecutions.set(unitId, executions);
    this.appendLog(taskId, unitId, 'status_change', { status: 'started' });

    const effectiveSelfReviewMax = task.selfReviewMaxAttempts ?? unit.selfReviewMaxAttempts;

    const runLoop = this.phaseLoopRunner.stateMachineLoop(
      { ...unit, selfReviewMaxAttempts: effectiveSelfReviewMax },
      serverName,
      task,
      server,
      target,
      abortController.signal,
      windowTarget,
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

        const repoEntry = project?.repositories?.[0];
        const repo = repoEntry ? this.projectRepo.findRepositoryById(repoEntry.id) : undefined;

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

    const server = this.serverRepo.findByName(serverName);
    if (!server) throw new Error('Server not found');

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

    let windowName = task.tmuxWindow || `task-${task.id}`;

    // Ensure tmux session and window exist. Same throwaway-bootstrap-window
    // reasoning as execute() above: no env at all when a session must be
    // created here, since the real task window (created just below, if it
    // doesn't already exist) is what actually gets AZITO_TASK_TOKEN.
    const existingSessions = await this.tmux.listSessions(server);
    const sessionExists = existingSessions.some((s) => s.name === tmuxSession);
    if (!sessionExists) {
      await this.tmux.createSession(server, tmuxSession, { extraEnv: {} });
      await sleep(500);
    }

    let windowExists = false;
    try {
      const sessions = await this.tmux.listSessions(server);
      const session = sessions.find((s) => s.name === tmuxSession);
      if (session) {
        windowExists = session.windows.some((w) => w.name === windowName);
      }
    } catch {}

    if (!windowExists) {
      try {
        // Window generation point for a follow-up that has no window to
        // resume onto — rotates the task token, same as execute() above. A
        // follow-up onto an ALREADY-existing window (the common case) never
        // reaches this branch at all, matching design v3 §2's "resume onto
        // an existing window never rotates".
        const created = await this.tmux.createWindow(server, tmuxSession, `task-${task.id}`, { extraEnv: this.paneEnvService.buildEnvForNewWindow(task, server) });
        windowName = created.windowName;
        this.taskRepo.update(taskId, { tmuxWindow: windowName } as Partial<Task>);
      } catch (err) {
        throw new Error(`Failed to create tmux window: ${err instanceof Error ? err.message : err}`);
      }
    }

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
          this.taskRepo.update(taskId, { status: 'failed' as TaskStatus, tmuxWindow: null } as Partial<Task>);
          // Same generation-leak fix as execute()'s worktree_failed branch
          // above — this branch only runs when !windowExists just created a
          // fresh window (and rotated the task token) for this follow-up.
          try {
            // See the worktree_creation_failed_rollback branch above for why
            // this checks resolveKillOutcome's verdict before revoking.
            const outcome = await resolveKillOutcome(this.tmux.killWindow(server, `${tmuxSession}:${windowName}`));
            if (outcome.success) {
              this.paneEnvService.revokeForDestroyedWindow(taskId, 'followup_working_directory_rejected_rollback');
            }
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
    followUpExecutions.push({ taskId, abortController, target, windowTarget: `${windowTarget}.1`, serverName });
    this.runningExecutions.set(unitId, followUpExecutions);
    this.appendLog(taskId, unitId, 'status_change', { status: 'follow_up_started', comment });

    const runFollowUp = async () => {
      // Generate unique markers for follow-up
      const nonce = Math.random().toString(36).slice(2, 8);
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
          await this.phaseLoopRunner.stateMachineLoop({ ...unit, selfReviewMaxAttempts: effectiveSelfReviewMax }, serverName, { ...task, currentPhase: origCurrentPhase }, server, target, abortController.signal, windowTarget);
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
    executions.push({ taskId, abortController, target, windowTarget: `${windowTarget}.1`, serverName });
    this.runningExecutions.set(unitId, executions);

    const effectiveSelfReviewMax = task.selfReviewMaxAttempts ?? unit.selfReviewMaxAttempts;

    this.phaseLoopRunner.stateMachineLoop(
      { ...unit, selfReviewMaxAttempts: effectiveSelfReviewMax },
      serverName,
      { ...task },
      server,
      target,
      abortController.signal,
      windowTarget,
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
    const repoEntry2 = project?.repositories?.[0];
    const repo = repoEntry2 ? this.projectRepo.findRepositoryById(repoEntry2.id) : null;
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
