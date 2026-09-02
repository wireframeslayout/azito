import { randomBytes } from 'crypto';
import type { ITaskRepository, Task } from '../Task';
import { extractPhaseSummary } from '../extractPhaseSummary';
import type { TaskStatus } from '../TaskStatus';
import type { SubagentConfig, WorkerExecutionMode, WorkerRuntime } from '../../units/Unit';
import { usesHttpSignalPath } from '../../units/Unit';
import type { WorkerRuntimeRegistry } from './runtime/WorkerRuntimeRegistry';
import type { IWorkerRuntime, WorkerContext } from './runtime/IWorkerRuntime';
import type { IProjectRepository } from '../../projects/Project';
import type { IProjectServerRepository } from '../../projects/ProjectServer';
import { resolveEffectiveInputPolicy } from '../../projects/ProjectServer';
import type { IServerRepository } from '../../servers/Server';
import type { SqliteProjectSecretRepository } from '../../projects/SqliteProjectSecretRepository';
import type { PhaseConfig } from '../../sidekicks/PhaseConfig';
import type { SidekickPackageLoader } from '../../sidekicks/SidekickPackageLoader';
import { resolvePhaseSidekick, resolveEnabledPhases, resolveCurrentPhaseIndex } from '../../sidekicks/resolvePhaseSidekick';
import { renderSidekickBody } from '../../sidekicks/renderSidekickBody';
import type { SidekickSyncService } from '../../sidekicks/SidekickSyncService';
import { resolveSidekickDir } from '../../sidekicks/SidekickSyncService';
import type { UnitTypeLoader } from '../../sidekicks/UnitTypeLoader';
import type { UnitTypePhase } from '../../sidekicks/UnitType';
import type { IWorktreeService } from '../../git/IWorktreeService';
import { resolvePushCredential } from '../../git/hub-transfer/pushCredential';
import type { ServerConfig } from '../../servers/Server';
import type { TransportFactory } from '../../servers/transport/TransportFactory';
import { buildSubagentDelegationBlock, buildSubagentRulesFileContent } from '../../prompt/PhasePromptRenderer';
import { loadPromptModules } from '../../prompt/PromptModuleLoader';
import { resolveTaskPromptVars } from '../../prompt/resolveTaskPromptVars';
import type { IUnitRepository } from '../../units/Unit';
import type { WorkerWaiter, AppendLogFn } from './WorkerWaiter';
import type { WorkerInputService } from './WorkerInputService';
import type { PushVerifier } from './PushVerifier';
import type { GitInfoCollector } from './GitInfoCollector';
import type { GitProviderService } from '../../git/providers/GitProviderService';
import type { HttpSignalTurnCoordinator } from './HttpSignalTurnCoordinator';
import type { PullRequestCreator } from './PullRequestCreator';
import type { PushNotaryService } from '../../git/hub-transfer/PushNotaryService';
import type { AgentTurn } from '../turns/AgentTurn';
import { checkExecutionGate } from './ExecutionGate';
import { resolveExecutionManifest, hashExecutionManifest } from './ExecutionManifest';
import { isDistributionRequiredButRepositoryUnresolved } from './DistributionHelper';
import type { ProjectRepository } from '../../projects/Project';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPromptDelivered(text: string): boolean {
  return /Thinking|Mulling|Hyperspacing|Deepening|esc to interrupt|AZITO_DONE_|<\/completion_signal>|⏺/i.test(text);
}

/** The subset of Unit fields the phase loop needs; selfReviewMaxAttempts may be overridden per-run by the caller. */
export interface UnitForRun {
  id: number;
  unitType: string;
  systemPrompt: string | null;
  selfReviewMaxAttempts: number;
  reviewSubagent: SubagentConfig | null;
  implementSubagent: SubagentConfig | null;
  phaseConfig: PhaseConfig | null;
  workerType: string | null;
  workerModel: string | null;
  workerExtraArgs: string | null;
  workerExecutionMode: WorkerExecutionMode;
  workerRuntime: WorkerRuntime;
  sleepAfterPush: boolean;
}

/**
 * Drives a task through its configured phases: building prompts from Sidekick
 * packages (resolved via resolvePhaseSidekick — Issue #263 Phase 5), sending
 * them to the worker, waiting for completion, and advancing/repeating phases
 * based on the classification result.
 *
 * Phase order, phase-specific behavior (plan approval, test rollback, push
 * verification, subagent delegation, self-review retry) are all driven by the
 * UnitType definition loaded from TOML — no hardcoded phase names.
 */
export class PhaseLoopRunner {
  constructor(
    private taskRepo: ITaskRepository,
    private projectRepo: IProjectRepository,
    private projectServerRepo: IProjectServerRepository,
    private unitRepo: IUnitRepository,
    private sidekickLoader: SidekickPackageLoader,
    private workerWaiter: WorkerWaiter,
    private pushVerifier: PushVerifier,
    private gitInfoCollector: GitInfoCollector,
    private gitProvider: GitProviderService,
    private pullRequestCreator: PullRequestCreator,
    private getWorktreeService: (server: ServerConfig) => IWorktreeService,
    private appendLog: AppendLogFn,
    private transportFactory: TransportFactory,
    private sidekickSyncService: SidekickSyncService,
    private httpSignalCoordinator: HttpSignalTurnCoordinator,
    private workerInput: WorkerInputService,
    private unitTypeLoader: UnitTypeLoader,
    private runtimeRegistry: WorkerRuntimeRegistry,
    // Required for reverifyExecutionGateForPhase()'s resolveExecutionManifest()
    // call below (Issue #328 tenth-round review) — same as
    // ExecuteTaskUseCase/TaskRestoreService/WindowRespawnService, this class
    // must resolve the manifest's `server`/`secrets` fields the same way a
    // real run does, not skip them because this class doesn't otherwise
    // depend on these repositories.
    private serverRepo: IServerRepository,
    private projectSecretRepo: SqliteProjectSecretRepository,
    // Issue #29 Step 3a: same flag ExecuteTaskUseCase is constructed with
    // (it constructs this class and passes its own copy through) — needed by
    // reverifyExecutionGateForPhase()'s resolveEffectiveInputPolicy() call
    // below, so a per-phase re-verification degrades 'allow' exactly the way
    // the run's original entry-point check did.
    private scopedAuthEnabled: boolean,
    private pushNotaryService: PushNotaryService | null,
    private sleepTaskWindows: (taskId: number) => Promise<number[]>,
  ) {}

  // Takes the already-resolved repository entry rather than re-deriving it
  // from `task.projectId` (Issue #87 13th-round review, Important finding):
  // the caller resolves it via `resolveExecutionRepositoryEntry` — the same
  // repository the pushing phase's PR/push verification/notarization
  // target — so this must never make its own separate `repositories[0]`
  // choice that could disagree with theirs.
  private async findPrUrl(repoEntry: ProjectRepository | null, branch: string | null): Promise<string | null> {
    if (!branch || !repoEntry) return null;
    const repo = this.projectRepo.findRepositoryById(repoEntry.id);
    if (!repo || !repo.owner || !repo.repoName) return null;
    try {
      const pr = await this.gitProvider.findPullRequestByBranch(repo, branch);
      return pr?.htmlUrl ?? null;
    } catch {
      return null;
    }
  }


  /**
   * Re-runs the untrusted-input execution gate (Issue #328 ninth-round
   * review) immediately before each phase's prompt is built and sent. The
   * gate at execute()/resumeStateMachine() entry (ExecuteTaskUseCase.
   * enforceExecutionGate) only fires ONCE, when a run starts or resumes —
   * but this loop resolves the Sidekick package, task vars, and Unit
   * config fresh for EVERY phase as the run progresses (see the
   * resolvePhaseSidekick/resolveTaskPromptVars calls right after this
   * method's call site below). An edit to anything the approval manifest
   * covers, made after entry but before a later phase runs, must not reach
   * the worker unattended.
   *
   * Reuses the exact same resolveExecutionManifest()/hashExecutionManifest()/
   * checkExecutionGate() triplet every other entry point uses (ExecuteTaskUseCase,
   * TaskRestoreService, WindowRespawnService) — no new comparison logic here,
   * only the orchestration (what to do on a block), mirroring
   * ExecuteTaskUseCase.enforceExecutionGate's own pending_approval/denied
   * handling since this class can't call that method directly (it belongs to
   * a different class and closes over ExecuteTaskUseCase-only state).
   *
   * Trusted tasks pay nothing extra for this: checkExecutionGate()
   * short-circuits on `inputTrust !== 'untrusted'` before this method ever
   * calls resolveExecutionManifest(), so a trusted task never resolves a
   * manifest (no per-phase file I/O) here.
   *
   * Returns true when the phase may proceed. Returns false when it blocked —
   * the caller must stop the loop (send nothing, launch nothing) without
   * throwing, since the block itself is the intended outcome, not a failure.
   */
  private reverifyExecutionGateForPhase(taskId: number, currentTask: Task, loopUnitId: number): boolean {
    if (currentTask.inputTrust !== 'untrusted') return true;

    // 'continuation': this is a per-phase re-check mid-run — the run's own
    // execute()/resumeStateMachine() entry already passed its own
    // 'execute'/'continuation' gate before this loop started, so code (if
    // any) has already been distributed for THIS run under that decision.
    const { manifest, projectServer, serverConfig } = resolveExecutionManifest(currentTask, {
      unitRepo: this.unitRepo,
      projectRepo: this.projectRepo,
      projectServerRepo: this.projectServerRepo,
      serverRepo: this.serverRepo,
      projectSecretRepo: this.projectSecretRepo,
      unitTypeLoader: this.unitTypeLoader,
      sidekickLoader: this.sidekickLoader,
    }, 'continuation');
    const manifestHash = hashExecutionManifest(manifest);
    // Issue #29 Step 3a: same re-check as ExecuteTaskUseCase.enforceExecutionGate
    // — see resolveEffectiveInputPolicy's doc comment.
    const effective = resolveEffectiveInputPolicy(projectServer, serverConfig, this.scopedAuthEnabled);
    const gate = checkExecutionGate(currentTask, effective.effectivePolicy, manifestHash);

    // Resolve a Unit id to attach log entries to WITHOUT ever falling back to
    // a dummy value (Issue #328 review round fix 4): execution_log.unit_id is
    // a real foreign key, so the old `manifest.unit?.id ?? currentTask.unitId
    // ?? 0` fallback chain could append a log row with unit_id = 0 — no such
    // Unit exists, so that write throws a foreign-key violation, turning a
    // benign "the configured Unit was deleted mid-run" drift into an
    // unrelated execution failure. Prefer the manifest's own fresh
    // resolution; if that came back null (the Unit really is gone), fall
    // back to `loopUnitId` — the Unit this very run started with, passed in
    // by stateMachineLoop() — but ONLY if it still resolves; otherwise skip
    // the unit-scoped log entirely (unitId stays null below) while still
    // recording the task-level gate transition (recordExecutionGateBlock /
    // updateStatus), which has no such foreign-key dependency. Resolved here
    // (before the `gate.allowed` fast-return) so a degraded 'allow' can be
    // logged even on a phase that a stale manual-approval match still lets
    // through unattended (Issue #29 Step 3a).
    const unitId = manifest.unit?.id ?? (this.unitRepo.findById(loopUnitId) ? loopUnitId : null);
    if (unitId !== null && effective.allowDegradedReason) {
      this.appendLog(taskId, unitId, 'command', {
        type: 'execution_policy_degraded',
        requestedPolicy: effective.requestedPolicy,
        effectivePolicy: effective.effectivePolicy,
        allowDegradedReason: effective.allowDegradedReason,
      });
    }
    if (gate.allowed) return true;

    if (unitId !== null) {
      this.appendLog(taskId, unitId, 'command', { type: 'execution_gate_blocked', reason: gate.reason });
    }
    if (gate.reason === 'pending_approval') {
      // Same 'resume' semantics as ExecuteTaskUseCase.followUp()/
      // resumeStateMachine()'s own gate call: on approval, units/routes.ts's
      // approve-execution handler resumes via resumeStateMachine(), which
      // re-enters this same loop at task.currentPhase — already set to this
      // phase by the updateCurrentPhase() call above the call site below, so
      // the resume lands exactly where this block happened.
      //
      // Atomic compare-and-swap (Issue #328 review round), same as
      // ExecuteTaskUseCase.enforceExecutionGate's own pending_approval
      // branch — see recordExecutionGateBlock's doc comment on
      // ITaskRepository for why an unconditional update here could
      // overwrite an already-recorded block from a concurrently-blocked
      // entry point. manifestHash is passed through so the guarded UPDATE
      // can also detect a concurrent approval that already matches this
      // exact manifest (Issue #328 review round fix 2).
      const recorded = this.taskRepo.recordExecutionGateBlock(taskId, {
        pendingOperation: 'resume',
        priorStatus: currentTask.status,
        manifestHash,
      });
      if (unitId !== null) {
        if (recorded) {
          // Same shape as ExecuteTaskUseCase.enforceExecutionGate's own
          // pending_approval log entry (Issue #328 review) — the notification
          // bridge only forwards a 'task:status' WS event off a 'status_change'
          // log entry (see that method's own comment), not off the 'command'
          // entry logged above. Without this, a drift block that happens
          // mid-run (as opposed to at execute()/resumeStateMachine() entry)
          // silently sat at pending_approval with nobody notified.
          this.appendLog(taskId, unitId, 'status_change', { status: 'pending_approval', operation: 'resume' });
        } else {
          this.appendLog(taskId, unitId, 'command', { type: 'execution_gate_already_pending', operation: 'resume' });
        }
      }
    } else {
      // 'denied': the project server's input policy changed to 'deny' mid-run.
      // Unlike the entry-point gates (which haven't started anything yet and
      // so leave status untouched), a run already in progress has no "leave
      // it alone" state to return to — fail it, the same outcome any other
      // hard stop mid-loop produces (send_error, stopped classification, etc).
      if (unitId !== null) {
        this.appendLog(taskId, unitId, 'status_change', { status: 'error', message: 'Execution denied by project server input policy (untrusted-origin task)' });
      }
      this.taskRepo.updateStatus(taskId, 'failed');
    }
    return false;
  }

  private async ensureSidekicksSynced(server: ServerConfig): Promise<void> {
    if (server.type === 'local') return;
    const transport = this.transportFactory.getTransport(server);
    await this.sidekickSyncService.sync(server.name, transport, this.sidekickLoader.list());
  }

  private async verifyPromptDelivery(
    runtime: IWorkerRuntime,
    workerContext: WorkerContext,
    prompt: string,
    phase: string,
  ): Promise<void> {
    await sleep(3000);
    const firstPaneText = await this.workerWaiter.capturePaneText(workerContext.server, workerContext.target);
    if (isPromptDelivered(firstPaneText)) return;

    this.appendLog(workerContext.taskId, workerContext.unitId, 'command', { type: 'prompt_retry', phase });
    try {
      await runtime.sendPrompt(workerContext, prompt);
    } catch {
      this.appendLog(workerContext.taskId, workerContext.unitId, 'command', { type: 'prompt_delivery_failed', phase });
      return;
    }

    await sleep(3000);
    const retryPaneText = await this.workerWaiter.capturePaneText(workerContext.server, workerContext.target);
    if (!isPromptDelivered(retryPaneText)) {
      this.appendLog(workerContext.taskId, workerContext.unitId, 'command', { type: 'prompt_delivery_failed', phase });
    }
  }

  // ─── State Machine Loop ───

  async stateMachineLoop(
    unit: UnitForRun,
    serverName: string,
    task: { id: number; projectId: number; title: string; description: string | null; status: TaskStatus; currentPhase: string | null; sleepAfterPush: boolean | null },
    server: ServerConfig,
    target: string,
    signal: AbortSignal,
    supervisorTarget: string,
    // Issue #87 review (forge/87-mirror follow-up), Important finding 1: the
    // repository this run treats as THE distribution target, resolved by the
    // CALLER once against whichever project/projectServer snapshot it locked
    // when it started/resumed this run (ExecuteTaskUseCase.execute() resolves
    // it from `lockedProject`/`lockedProjectServer`, the exact snapshot
    // `performDistribution()` itself distributed against). This method used
    // to re-derive it here via a fresh `projectRepo.findById()`/
    // `projectServerRepo.find()` read — a run can span many phases over
    // minutes to hours, so a `distributionRepositoryId` edit mid-run could
    // make that fresh read disagree with what was actually distributed onto
    // the server, silently retargeting prompt/PR-creation/push-verification/
    // hub-notarization/final-PR-URL-lookup at a DIFFERENT repository than the
    // one the code came from. Every downstream repository decision below
    // MUST use this parameter directly, never re-resolve it from `project`/
    // `projectServer` (still read below, but only for non-repository fields
    // like `workingDirectory` fallbacks).
    distributionRepoEntry: ProjectRepository | null,
    // Issue #87 review (forge/87-mirror follow-up), Important finding 2
    // (second round): whether distribution was required for this run,
    // decided by the CALLER at the exact same moment (against the exact same
    // locked project/projectServer snapshot) it resolved
    // `distributionRepoEntry` above — never re-derived inside this method
    // from a fresh `projectServerRepo.find()` read. This method used to
    // recompute "is distribution required" itself via
    // `isDistributionRequiredButRepositoryUnresolved(server, projectServer,
    // ...)`, reading `projectServer` from its OWN `projectServerRepo.find()`
    // call below — a `distributeCode` toggle flipped between when the caller
    // locked `distributionRepoEntry` and whenever that fresh read happened
    // (a run spans many phases, potentially over minutes to hours, and
    // resumes/follow-ups each re-enter this method) could make the fresh
    // read see `distributeCode: false` even though the run's locked
    // repository had since been deleted — silently turning the pushing
    // probe's fail-closed check off and letting `null` reach PR creation/
    // push verification, reviving the SHA-only-match bypass that check
    // exists to prevent. See `isDistributionRequiredButRepositoryUnresolved`'s
    // doc comment (DistributionHelper.ts) for the full rationale.
    distributionRequired: boolean,
  ): Promise<void> {
    const project = this.projectRepo.findById(task.projectId);
    const projectServer = project ? this.projectServerRepo.find(task.projectId, serverName) : null;

    const unitType = this.unitTypeLoader.getOrThrow(unit.unitType);
    const enabledPhases = resolveEnabledPhases(unit.phaseConfig, unitType.phases);
    const phaseDefMap = new Map(unitType.phases.map((p) => [p.name, p]));

    await this.ensureSidekicksSynced(server);

    let selfReviewCount = 0;
    const maxSelfReview = unit.selfReviewMaxAttempts ?? 2;
    let isFirstPromptSent = false;

    // Shared with ExecutionManifest.ts's approval-manifest resolution
    // (resolveCurrentPhaseIndex) so the phase a human approves is guaranteed
    // to be the phase this loop actually resumes at (Issue #328 sixth-round
    // review) — enabledPhases here is the same list already computed above.
    let { index: currentPhaseIndex } = resolveCurrentPhaseIndex(unit.phaseConfig, unitType.phases, task.currentPhase);

    while (currentPhaseIndex < enabledPhases.length) {
      if (signal.aborted) {
        this.appendLog(task.id, unit.id, 'status_change', { status: 'stopped_by_user' });
        this.taskRepo.updateStatus(task.id, 'failed');
        return;
      }

      const phase = enabledPhases[currentPhaseIndex];
      const phaseDef = phaseDefMap.get(phase)!;

      // Untrusted-input execution gate re-check (Issue #328 ninth-round
      // review) — must run BEFORE the isolation cutoff below and BEFORE the
      // Sidekick is resolved / prompt is built further down, so a block
      // never lets a stale/rewritten instruction reach the worker, and a
      // skipped pushing phase never bypasses a gate that would otherwise
      // have caught drift (Issue #29 review, Important finding 1): the
      // isolation cutoff advances the task straight to the terminal 'review'
      // status without ever building a prompt, so re-checking after it would
      // never run for the one phase it guards. See
      // reverifyExecutionGateForPhase's doc comment.
      const currentTask = this.taskRepo.findById(task.id);
      if (currentTask && !this.reverifyExecutionGateForPhase(task.id, currentTask, unit.id)) {
        return;
      }

      // Isolation cutoff (Issue #29 docs review, Important finding 1):
      // isolated agent servers never hold push credentials (see
      // ServerIsolationLock.ts / TaskPaneEnvironmentService.ts — the same
      // isolationIntent gate that withholds secrets from the task pane).
      // PushNotaryService is always wired in production (wiring.ts L421);
      // reaching this branch signals a configuration defect. An isolated
      // server has no other push path, so skipping would let the task
      // complete with nothing pushed — fail instead.
      if (server.isolationIntent === true && phaseDef.pushVerify && !this.pushNotaryService) {
        this.taskRepo.updateCurrentPhase(task.id, phase);
        this.appendLog(task.id, unit.id, 'status_change', {
          status: 'hub_push_failed',
          error: 'PushNotaryService is not wired but is required for hub-proxied push on an isolated server',
        });
        this.taskRepo.updateStatus(task.id, 'failed');
        return;
      }

      this.taskRepo.updateStatus(task.id, 'running');
      this.taskRepo.updateCurrentPhase(task.id, phase);
      this.appendLog(task.id, unit.id, 'status_change', { status: 'phase_started', phase });

      const sidekick = resolvePhaseSidekick(this.sidekickLoader, phase, unit.phaseConfig, phaseDef);
      const sidekickDir = resolveSidekickDir(sidekick, server);
      const promptModules = loadPromptModules();
      // Issue #87 review (14th round), Minor finding: pass the SAME
      // distribution-aware repository this phase's own push/PR/notary
      // logic uses (below) down into the prompt vars, so `AZITO_GIT_PROVIDER`
      // names the actual provider the worker is pushing to (`gh`/`glab`)
      // instead of always `project.repositories[0]`'s — see
      // `resolveTaskPromptVars`'s doc comment on `resolvedGitProvider`.
      // Uses the caller-locked `distributionRepoEntry` (Issue #87 review,
      // forge/87-mirror follow-up, Important finding 1), not a fresh
      // re-resolution — see this method's parameter doc comment.
      const vars = resolveTaskPromptVars(this.taskRepo, this.projectRepo, this.unitRepo, this.projectServerRepo, task.id, distributionRepoEntry?.provider);
      const expandedPrompt = renderSidekickBody(sidekick, {
        ...vars,
        selfReview: {
          attempt: String(selfReviewCount + 1),
          maxAttempts: String(maxSelfReview),
        },
      }, false, sidekickDir);

      const resolvedSubagentConfig: SubagentConfig | null = (() => {
        if (phaseDef.subagentRole === 'review') return currentTask?.reviewSubagent ?? unit.reviewSubagent ?? null;
        if (phaseDef.subagentRole === 'implement') return currentTask?.implementSubagent ?? unit.implementSubagent ?? null;
        return null;
      })();

      // crypto.randomBytes (not Math.random) — the nonce is also embedded in
      // turnToken (design v3 §8), which /api/agent-signals now accepts as a
      // standalone credential, so it must not be predictable.
      const nonce = randomBytes(16).toString('hex');

      const effectiveWorkerType = unit.workerType ?? 'generic';
      let prompt: string;
      if (resolvedSubagentConfig?.enabled === true && phaseDef.subagentRole) {
        const rulesFilePath = `/tmp/azito-rules-${task.id}-${nonce}.md`;
        const role = phaseDef.subagentRole;
        const rulesContent = role === 'review'
          ? buildSubagentRulesFileContent('review', {
              reviewPerspectives: promptModules.reviewPerspectives,
              implementationRules: promptModules.implementationRules,
            })
          : buildSubagentRulesFileContent('implement', {
              softwareDesignPrinciples: promptModules.softwareDesignPrinciples,
              uiDesignPrinciples: promptModules.uiDesignPrinciples,
              implementationRules: promptModules.implementationRules,
            });
        await this.gitInfoCollector.writeRemoteFile(server, rulesFilePath, rulesContent);
        prompt = expandedPrompt + buildSubagentDelegationBlock(
          role,
          resolvedSubagentConfig,
          effectiveWorkerType,
          rulesFilePath,
        );
      } else {
        prompt = expandedPrompt;
      }

      const doneMarker = `AZITO_DONE_${task.id}_${nonce}`;
      const questionsMarker = `AZITO_QUESTIONS_${task.id}_${nonce}`;
      const testFailedMarker = `AZITO_TEST_FAILED_${task.id}_${nonce}`;

      const phaseStream = this.workerWaiter.startPaneStream(server, target, task.id, unit.id);
      if (!phaseStream) return;

      const outputFilePath = `/tmp/azito-output-${task.id}-${nonce}.md`;
      const httpSignalMode = usesHttpSignalPath(unit.workerExecutionMode);
      const capability = { questions: phaseDef.questions, testFailed: phaseDef.testFailed };

      const runtime = this.runtimeRegistry.get(unit.workerRuntime);
      const envelopeResult = runtime.buildEnvelope({
        phase, capability, nonce,
        taskId: task.id, unitId: unit.id, workerExecutionMode: unit.workerExecutionMode,
        server, target, supervisorTarget: supervisorTarget, prompt, outputFilePath,
        doneMarker, questionsMarker, testFailedMarker,
      });
      const phaseSignalStream = envelopeResult.signalStream;
      const markerizedPromptWithSignal = envelopeResult.markerizedPrompt;
      let httpSignalTurn = envelopeResult.httpSignalTurn;

      this.appendLog(task.id, unit.id, 'command', { type: 'phase_prompt', phase, text: markerizedPromptWithSignal, doneMarker, questionsMarker, outputFilePath });

      const workerContext: WorkerContext = { server, target, supervisorTarget: supervisorTarget, taskId: task.id, unitId: unit.id };
      try {
        await runtime.sendPrompt(workerContext, markerizedPromptWithSignal);
      } catch (err: unknown) {
        phaseStream.stop();
        phaseSignalStream.stop();
        this.appendLog(task.id, unit.id, 'status_change', { status: 'send_error', message: (err as Error).message });
        this.taskRepo.updateStatus(task.id, 'failed');
        return;
      }
      if (!isFirstPromptSent) {
        await this.verifyPromptDelivery(runtime, workerContext, markerizedPromptWithSignal, phase);
        isFirstPromptSent = true;
      }

      let pushingProbe: (() => Promise<boolean>) | undefined;
      if (phaseDef.pushVerify && !(server.isolationIntent && this.pushNotaryService)) {
        const currentTaskForProbe = this.taskRepo.findById(task.id);
        const probeDir = await (async () => {
          const wtPath = currentTaskForProbe?.worktreePath;
          if (wtPath && await this.getWorktreeService(server).exists(wtPath)) return wtPath;
          return currentTaskForProbe?.workingDirectory || projectServer?.workingDirectory;
        })();
        const probeBranch = currentTaskForProbe?.worktreeBranch ?? currentTaskForProbe?.branch;
        if (probeDir && probeBranch) {
          // Issue #87 13th-round review, Important finding: must agree with
          // whichever repository distribution actually pulled onto this
          // server, not always `repositories[0]` — uses the caller-locked
          // `distributionRepoEntry` (Issue #87 review, forge/87-mirror
          // follow-up, Important finding 1), never a fresh re-resolution —
          // see this method's parameter doc comment.
          const probeRepo = distributionRepoEntry ? this.projectRepo.findRepositoryById(distributionRepoEntry.id) : null;
          pushingProbe = async () => {
            // Issue #87 review (forge/87-mirror follow-up), Important
            // finding 2: fail closed — same rule as
            // ExecuteTaskUseCase.isPushCompleted(), shared via
            // `isDistributionRequiredButRepositoryUnresolved` (see its doc
            // comment) — when distribution is required but the target
            // repository could not be resolved, never call PR creation or
            // push verification (which would otherwise accept a SHA-only
            // match against nothing in particular); treat the phase as
            // not-yet-completed instead. Uses the caller-locked
            // `distributionRequired` parameter (second-round fix), not a
            // fresh `isDistributionRequired(server, projectServer)`
            // re-derivation — see this method's `distributionRequired`
            // parameter doc comment.
            if (isDistributionRequiredButRepositoryUnresolved(distributionRequired, probeRepo)) {
              this.appendLog(task.id, unit.id, 'command', { type: 'pushing_probe_blocked_unresolved_repository' });
              return false;
            }
            // Create the PR (if due) before verifying — verifyPushCompleted's own
            // PR-existence check then sees what this call just created.
            // PullRequestCreator itself never rejects (best-effort, self-contained
            // try/catch), but this probe stays defensive regardless: a rejection
            // here must never take down the pushing completion check with it.
            if (!currentTaskForProbe?.skipPr) {
              try {
                await this.pullRequestCreator.ensureCreated(task.id, unit.id, probeRepo, probeBranch, {
                  title: currentTaskForProbe?.title ?? task.title,
                  description: currentTaskForProbe?.description ?? null,
                  targetBranch: currentTaskForProbe?.targetBranch ?? null,
                });
              } catch { /* best-effort: never block push verification on PR creation */ }
            }
            return this.pushVerifier.verifyPushCompleted(server, probeDir, probeBranch, currentTaskForProbe?.skipPr, probeRepo);
          };
        }
      }

      const waitResult = await this.workerWaiter.waitForWorker(server, target, task.id, unit.id, signal, phaseStream, doneMarker, phaseSignalStream, pushingProbe, supervisorTarget);
      const output = waitResult.output;
      let classification = waitResult.classification;
      let httpSignalFinalTurn: AgentTurn | null = httpSignalTurn;
      if (httpSignalMode && httpSignalTurn) {
        const finalized = await this.httpSignalCoordinator.finalize(httpSignalTurn.id, classification, signal.aborted);
        classification = finalized.classification;
        httpSignalFinalTurn = finalized.turn;
      }

      if (classification.status === 'question') {
        this.appendLog(task.id, unit.id, 'output', output);
        this.taskRepo.update(task.id, { pendingQuestions: JSON.stringify(classification.questions || []) } as Partial<Task>);
        this.appendLog(task.id, unit.id, 'status_change', { status: 'waiting_for_human', question: output });
        this.taskRepo.updateStatus(task.id, 'waiting_input');
        return;
      }

      if (classification.status === 'stopped') {
        this.appendLog(task.id, unit.id, 'output', output);
        this.appendLog(task.id, unit.id, 'status_change', { status: 'error', message: 'Agent stopped unexpectedly' });
        this.taskRepo.updateStatus(task.id, 'failed');
        return;
      }

      const phaseOutput = httpSignalMode && httpSignalFinalTurn
        ? this.httpSignalCoordinator.readOutput(httpSignalFinalTurn.id) ?? await this.workerWaiter.readPhaseOutputFile(server, outputFilePath)
        : await this.workerWaiter.readPhaseOutputFile(server, outputFilePath);
      if (phaseOutput !== null) {
        this.appendLog(task.id, unit.id, 'command', { type: 'phase_output_read', length: phaseOutput.length });
      } else {
        this.appendLog(task.id, unit.id, 'command', { type: 'phase_output_missing' });
      }

      if (httpSignalMode && httpSignalFinalTurn && phaseOutput === null
          && httpSignalFinalTurn.completionSource !== 'azitoctl' && !pushingProbe) {
        this.httpSignalCoordinator.rejectInferredCompletion(httpSignalFinalTurn.id);
        this.appendLog(task.id, unit.id, 'command', { type: 'phase_complete_without_output_rejected', phase, turnId: httpSignalFinalTurn.id });
        this.appendLog(task.id, unit.id, 'output', output);
        this.appendLog(task.id, unit.id, 'status_change', { status: 'error', message: 'Agent stopped unexpectedly' });
        this.taskRepo.updateStatus(task.id, 'failed');
        return;
      }

      const rawOutput = phaseOutput !== null ? phaseOutput : output;
      const { cleanOutput, summary: phaseSummary } = extractPhaseSummary(rawOutput);
      this.appendLog(task.id, unit.id, 'output', cleanOutput);

      if (phaseSummary) {
        this.appendLog(task.id, unit.id, 'command', { type: 'phase_summary_extracted', phase });
        try {
          const currentTask = this.taskRepo.findById(task.id);
          const existing = currentTask?.summaryJson ? JSON.parse(currentTask.summaryJson) as Record<string, unknown> : { phases: [] };
          if (!Array.isArray(existing.phases)) existing.phases = [];
          (existing.phases as Record<string, unknown>[]).push(phaseSummary);
          this.taskRepo.update(task.id, { summaryJson: JSON.stringify(existing) } as Partial<Task>);
        } catch (e) {
          this.appendLog(task.id, unit.id, 'command', { type: 'phase_summary_accumulate_error', error: String(e) });
        }
      } else {
        this.appendLog(task.id, unit.id, 'command', { type: 'phase_summary_missing', phase });
      }

      this.appendLog(task.id, unit.id, 'command', { type: 'phase_completed', phase, summary: phaseSummary ?? null });

      // Hub push notarization for isolated servers (Issue #87 Phase 2)
      if (server.isolationIntent && phaseDef.pushVerify && this.pushNotaryService
          && classification.status === 'phase_complete') {
        // Issue #87 13th-round review, Important finding: the hub push
        // notary must target the SAME repository fetch distribution pulled
        // onto this isolated server. Uses the caller-locked
        // `distributionRepoEntry` (Issue #87 review, forge/87-mirror
        // follow-up, Important finding 1), not a fresh
        // `projectRepo.findById()`/`resolveExecutionRepositoryEntry()`
        // re-resolution — see this method's parameter doc comment.
        if (!distributionRepoEntry) {
          // `server.isolationIntent` gates this whole block, so
          // `isDistributionRequired` is true here and
          // `resolveExecutionRepositoryEntry` NEVER falls back to
          // `project.repositories[0]` for it (see that function's doc
          // comment, Issue #87 14th-round review) — a `null` here means the
          // distributed repository is unset or was deleted, i.e. the one
          // fact hub push notarization exists to agree with is unknown.
          // Notarizing against `repositories[0]` would silently push this
          // isolated server's code to the WRONG repository; silently
          // skipping notarization (the old `no_push_credential` path this
          // fell through to) would instead let the phase advance as if the
          // push had happened when nothing was ever pushed. Neither is
          // acceptable for a write-capable operation — fail the task.
          this.appendLog(task.id, unit.id, 'status_change', {
            status: 'hub_push_failed',
            error: 'Fetch distribution repository could not be resolved for hub push notarization (unset or deleted distribution target repository)',
          });
          this.taskRepo.updateStatus(task.id, 'failed');
          return;
        }
        const probeRepo = this.projectRepo.findRepositoryById(distributionRepoEntry.id);
        if (probeRepo === null) {
          // Issue #87 review follow-up, Important finding 2: `distributionRepoEntry`
          // was resolved once when this run started/resumed and stays non-null
          // for the rest of the (possibly hours-long) loop — but the actual
          // `project_repositories` row it points at can be deleted mid-run.
          // The OLD code folded this into the `probeRepo?.token` falsy check
          // below and fell through to `no_push_credential`, which only LOGS
          // a skip and lets the phase advance as `phase_complete` — silently
          // completing the task without ever pushing/notarizing anything.
          // A deleted target repository is not "no credential configured"
          // (an accepted, intentionally-tolerated configuration state); it
          // is "the repository this run must notarize against no longer
          // exists" — the same hard-fail this method already applies above
          // when `distributionRepoEntry` itself is null. Treat it the same
          // way: fail the task, never silently skip.
          this.appendLog(task.id, unit.id, 'status_change', {
            status: 'hub_push_failed',
            error: 'Fetch distribution repository was removed during execution and could not be resolved for hub push notarization',
          });
          this.taskRepo.updateStatus(task.id, 'failed');
          return;
        }
        // Two-stage credential resolution (Issue #87): the repository's own
        // PAT first, then the hub operator's `gh`/`glab` token for that
        // repository's canonical host — the same resolution fetch
        // distribution applies (`docs/ja/github-integration.md`). Before
        // this, an isolated server whose repository had no PAT completed the
        // pushing phase having pushed nothing at all, even when the hub was
        // perfectly able to push with its own CLI login.
        //
        // Resolved HERE, not inside `PushNotaryService`: this call site also
        // owns the "no credential at all" verdict below, so keeping both in
        // one place is what makes it impossible for one stage to be applied
        // in one and skipped in the other.
        const pushCredential = await resolvePushCredential(probeRepo);
        if (pushCredential) {
          this.appendLog(task.id, unit.id, 'command', { type: 'hub_push_start', resolvedCredentialSource: pushCredential.source });
          const currentTaskForPush = this.taskRepo.findById(task.id);
          const probeDir = await (async () => {
            const wtPath = currentTaskForPush?.worktreePath;
            if (wtPath && await this.getWorktreeService(server).exists(wtPath)) return wtPath;
            const ps = this.projectServerRepo.find(task.projectId, serverName);
            return currentTaskForPush?.workingDirectory || ps?.workingDirectory;
          })();
          const probeBranch = currentTaskForPush?.worktreeBranch ?? currentTaskForPush?.branch;
          if (probeDir && probeBranch) {
            const transport = this.transportFactory.getTransport(server);
            const notaryResult = await this.pushNotaryService.notarize({
              taskId: task.id,
              unitId: unit.id,
              server,
              transport,
              worktreePath: probeDir,
              branch: probeBranch,
              baseBranch: currentTaskForPush?.targetBranch ?? null,
              repo: probeRepo,
              token: pushCredential.token,
            });
            if (notaryResult.status === 'failed') {
              this.appendLog(task.id, unit.id, 'status_change', { status: 'hub_push_failed', error: notaryResult.error });
              this.taskRepo.updateStatus(task.id, 'failed');
              return;
            }
            // `resolvedCredentialSource` names which credential was RESOLVED
            // for this notarization, not necessarily one that pushed:
            // `notarize()` can return `already_up_to_date` without pushing at
            // all (PushNotaryService.ts). The sibling `status` field is what
            // says whether a push happened; this field only answers "which
            // credential would have been / was used". Never the token itself —
            // completion too: a `cli` credential is ambient hub-operator
            // environment that `gh auth logout` removes without any AZITO
            // configuration changing, so a later reader of this log must be
            // able to tell which credential a past push actually used.
            this.appendLog(task.id, unit.id, 'command', { type: 'hub_push_completed', sha: notaryResult.sha, status: notaryResult.status, resolvedCredentialSource: pushCredential.source });
            if (!currentTaskForPush?.skipPr) {
              try {
                await this.pullRequestCreator.ensureCreated(task.id, unit.id, probeRepo, probeBranch, {
                  title: currentTaskForPush?.title ?? task.title,
                  description: currentTaskForPush?.description ?? null,
                  targetBranch: currentTaskForPush?.targetBranch ?? null,
                });
              } catch (prErr) {
                // #124 Bug 3: log PR creation failures so "push succeeded but
                // no PR was created" is distinguishable in execution logs.
                this.appendLog(task.id, unit.id, 'command', {
                  type: 'hub_pr_create_failed',
                  error: prErr instanceof Error ? prErr.message : String(prErr),
                });
              }
            }
          } else {
            this.appendLog(task.id, unit.id, 'status_change', {
              status: 'hub_push_failed',
              error: 'Hub-proxied push requires a worktree path and branch, but neither could be resolved for this task',
            });
            this.taskRepo.updateStatus(task.id, 'failed');
            return;
          }
        } else {
          // An isolated server has no other way to push: its own git holds
          // no credential and the distributed working directory's `origin`
          // is a dummy URL. Skipping here (the pre-#87 semantics) let the
          // phase advance as if the push had happened, so the task reached
          // `review` with nothing on the remote — indistinguishable from a
          // real success. Same verdict the unresolved-repository branch
          // above already applies: a write-capable operation that cannot
          // write must fail, not silently succeed.
          this.appendLog(task.id, unit.id, 'status_change', {
            status: 'hub_push_failed',
            error: 'Hub-proxied push is the only push path for an isolated server, but neither a repository PAT nor a hub gh/glab CLI token is available',
          });
          this.taskRepo.updateStatus(task.id, 'failed');
          return;
        }
      }

      // Plan approval: extract plan markdown and optionally wait for approval
      if (phaseDef.planApproval) {
        const planMarkdown = phaseOutput !== null
          ? cleanOutput
          : await this.workerWaiter.extractPlanWithFallback(server, target, output);
        if (planMarkdown) {
          this.taskRepo.update(task.id, { planMarkdown } as Partial<Task>);
        }

        const currentTask = this.taskRepo.findById(task.id);
        if (currentTask && currentTask.requirePlanApproval) {
          this.appendLog(task.id, unit.id, 'status_change', { status: 'phase_review', planOutput: cleanOutput });
          this.taskRepo.updateStatus(task.id, 'phase_review');
          return;
        }
      }

      // Test failure rollback
      if (phaseDef.testFailed) {
        const testFailedByHttpSignal = httpSignalMode && httpSignalFinalTurn?.status === 'test_failed';
        if (output.includes(testFailedMarker) || (phaseOutput !== null && phaseOutput.includes(testFailedMarker)) || testFailedByHttpSignal) {
          if (phaseDef.testFailedRollbackTo && selfReviewCount + 1 < maxSelfReview) {
            selfReviewCount++;
            this.taskRepo.update(task.id, { selfReviewCount });
            const rollbackIdx = enabledPhases.indexOf(phaseDef.testFailedRollbackTo);
            if (rollbackIdx >= 0) {
              currentPhaseIndex = rollbackIdx;
              continue;
            }
          }
        }
      }

      // Self-review retry
      if (phaseDef.selfReviewRetry && classification.status !== 'phase_complete') {
        if (selfReviewCount + 1 < maxSelfReview) {
          selfReviewCount++;
          this.taskRepo.update(task.id, { selfReviewCount });
          continue;
        }
      }

      currentPhaseIndex++;
    }

    // All phases complete — collect git info and PR URL
    const taskForGitInfo = this.taskRepo.findById(task.id);
    const workingDir = await (async () => {
      const t = taskForGitInfo;
      if (t?.worktreePath && await this.getWorktreeService(server).exists(t.worktreePath)) return t.worktreePath;
      const project = this.projectRepo.findById(task.projectId);
      const ps = project ? this.projectServerRepo.find(task.projectId, serverName) : null;
      return t?.workingDirectory || ps?.workingDirectory || '.';
    })();
    const baseBranchForDiff = taskForGitInfo?.baseBranch ?? undefined;
    const gitInfo = server.type === 'local'
      ? this.gitInfoCollector.collectGitInfoSync(workingDir, baseBranchForDiff)
      : await this.gitInfoCollector.collectGitInfoRemote(server, workingDir, baseBranchForDiff);
    // Uses the caller-locked `distributionRepoEntry` (Issue #87 review,
    // forge/87-mirror follow-up, Important finding 1), not a fresh
    // re-resolution — see this method's parameter doc comment.
    const prUrl = await this.findPrUrl(distributionRepoEntry, gitInfo.branch);
    const updateFields: Record<string, unknown> = {};
    if (prUrl) updateFields.prUrl = prUrl;
    if (gitInfo.changedFiles) updateFields.changedFiles = gitInfo.changedFiles;
    // worktreeBranch, not branch (Issue #328 review round): `branch` is the
    // value the execution-gate fingerprint hashes as `branches.work`
    // (ExecutionManifest.ts) — writing this end-of-run git-resolved branch
    // back into it made an already-approved task's OWN completed run
    // invalidate the approval a subsequent operation (e.g. a follow-up)
    // would need. worktreeBranch is the system-resolved field, already on
    // the fingerprint's deliberately-excluded list for this exact reason.
    if (gitInfo.branch) updateFields.worktreeBranch = gitInfo.branch;
    if (Object.keys(updateFields).length > 0) {
      this.taskRepo.update(task.id, updateFields as Partial<Task>);
    }

    const finalTask = this.taskRepo.findById(task.id);
    if (finalTask?.summaryJson) {
      try {
        const summary = JSON.parse(finalTask.summaryJson) as { phases: Array<{ tokensUsed?: { input?: number; output?: number } }>; taskId?: number; title?: string; totalTokens?: { input: number; output: number }; completedAt?: string };
        summary.taskId = task.id;
        summary.title = task.title;
        summary.totalTokens = summary.phases.reduce(
          (acc, p) => ({
            input: acc.input + (p.tokensUsed?.input ?? 0),
            output: acc.output + (p.tokensUsed?.output ?? 0),
          }),
          { input: 0, output: 0 },
        );
        summary.completedAt = new Date().toISOString();
        this.taskRepo.update(task.id, { summaryJson: JSON.stringify(summary) } as Partial<Task>);
      } catch (e) {
        this.appendLog(task.id, unit.id, 'command', { type: 'summary_finalize_error', error: String(e) });
      }
    }

    this.appendLog(task.id, unit.id, 'status_change', { status: 'done', summary: 'All phases completed.', ...gitInfo });
    this.taskRepo.updateStatus(task.id, 'review');

    const shouldSleep = (finalTask ?? task).sleepAfterPush ?? unit.sleepAfterPush;
    if (shouldSleep) {
      try {
        const sleptIds = await this.sleepTaskWindows(task.id);
        if (sleptIds.length > 0) {
          this.appendLog(task.id, unit.id, 'command', { type: 'window_sleep', windowIds: sleptIds });
        }
      } catch {
        // sleep failure must not block task completion
      }
    }
  }
}
