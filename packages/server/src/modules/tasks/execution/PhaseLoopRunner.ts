import type { ITaskRepository, Task } from '../Task';
import { extractPhaseSummary } from '../extractPhaseSummary';
import type { TaskStatus } from '../TaskStatus';
import type { SubagentConfig, WorkerExecutionMode, WorkerRuntime } from '../../units/Unit';
import { usesHttpSignalPath } from '../../units/Unit';
import type { WorkerRuntimeRegistry } from './runtime/WorkerRuntimeRegistry';
import type { IWorkerRuntime, WorkerContext } from './runtime/IWorkerRuntime';
import type { IProjectRepository } from '../../projects/Project';
import type { IProjectServerRepository } from '../../projects/ProjectServer';
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
import type { AgentTurn } from '../turns/AgentTurn';
import { checkExecutionGate } from './ExecutionGate';
import { resolveExecutionManifest, hashExecutionManifest } from './ExecutionManifest';

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
  ) {}

  private async findPrUrl(task: { projectId: number }, branch: string | null): Promise<string | null> {
    if (!branch) return null;
    const project = this.projectRepo.findById(task.projectId);
    const repoEntry = project?.repositories?.[0];
    if (!repoEntry) return null;
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
  private reverifyExecutionGateForPhase(taskId: number, currentTask: Task): boolean {
    if (currentTask.inputTrust !== 'untrusted') return true;

    const { manifest, projectServer } = resolveExecutionManifest(currentTask, {
      unitRepo: this.unitRepo,
      projectRepo: this.projectRepo,
      projectServerRepo: this.projectServerRepo,
      serverRepo: this.serverRepo,
      projectSecretRepo: this.projectSecretRepo,
      unitTypeLoader: this.unitTypeLoader,
      sidekickLoader: this.sidekickLoader,
    });
    const gate = checkExecutionGate(currentTask, projectServer, hashExecutionManifest(manifest));
    if (gate.allowed) return true;

    const unitId = manifest.unit?.id ?? currentTask.unitId ?? 0;
    this.appendLog(taskId, unitId, 'command', { type: 'execution_gate_blocked', reason: gate.reason });
    if (gate.reason === 'pending_approval') {
      // Same 'resume' semantics as ExecuteTaskUseCase.followUp()/
      // resumeStateMachine()'s own gate call: on approval, units/routes.ts's
      // approve-execution handler resumes via resumeStateMachine(), which
      // re-enters this same loop at task.currentPhase — already set to this
      // phase by the updateCurrentPhase() call above the call site below, so
      // the resume lands exactly where this block happened.
      this.taskRepo.update(taskId, {
        status: 'pending_approval',
        pendingOperation: 'resume',
        pendingOperationPriorStatus: currentTask.status,
      } as Partial<Task>);
    } else {
      // 'denied': the project server's input policy changed to 'deny' mid-run.
      // Unlike the entry-point gates (which haven't started anything yet and
      // so leave status untouched), a run already in progress has no "leave
      // it alone" state to return to — fail it, the same outcome any other
      // hard stop mid-loop produces (send_error, stopped classification, etc).
      this.appendLog(taskId, unitId, 'status_change', { status: 'error', message: 'Execution denied by project server input policy (untrusted-origin task)' });
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
    task: { id: number; projectId: number; title: string; description: string | null; status: TaskStatus; currentPhase: string | null },
    server: ServerConfig,
    target: string,
    signal: AbortSignal,
    supervisorTarget: string,
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

      this.taskRepo.updateStatus(task.id, 'running');
      this.taskRepo.updateCurrentPhase(task.id, phase);
      this.appendLog(task.id, unit.id, 'status_change', { status: 'phase_started', phase });

      // Untrusted-input execution gate re-check (Issue #328 ninth-round
      // review) — must run BEFORE the Sidekick is resolved and the prompt is
      // built below, so a block never lets a stale/rewritten instruction
      // reach the worker. See reverifyExecutionGateForPhase's doc comment.
      const currentTask = this.taskRepo.findById(task.id);
      if (currentTask && !this.reverifyExecutionGateForPhase(task.id, currentTask)) {
        return;
      }

      const sidekick = resolvePhaseSidekick(this.sidekickLoader, phase, unit.phaseConfig, phaseDef);
      const sidekickDir = resolveSidekickDir(sidekick, server);
      const promptModules = loadPromptModules();
      const vars = resolveTaskPromptVars(this.taskRepo, this.projectRepo, this.unitRepo, this.projectServerRepo, task.id);
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

      const nonce = Math.random().toString(36).slice(2, 8);

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
      if (phaseDef.pushVerify) {
        const currentTaskForProbe = this.taskRepo.findById(task.id);
        const probeDir = await (async () => {
          const wtPath = currentTaskForProbe?.worktreePath;
          if (wtPath && await this.getWorktreeService(server).exists(wtPath)) return wtPath;
          return currentTaskForProbe?.workingDirectory || projectServer?.workingDirectory;
        })();
        const probeBranch = currentTaskForProbe?.worktreeBranch ?? currentTaskForProbe?.branch;
        if (probeDir && probeBranch) {
          const probeRepoEntry = project?.repositories?.[0] ?? null;
          const probeRepo = probeRepoEntry ? this.projectRepo.findRepositoryById(probeRepoEntry.id) : null;
          pushingProbe = async () => {
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
    const prUrl = await this.findPrUrl(task, gitInfo.branch);
    const updateFields: Record<string, unknown> = {};
    if (prUrl) updateFields.prUrl = prUrl;
    if (gitInfo.changedFiles) updateFields.changedFiles = gitInfo.changedFiles;
    if (gitInfo.branch) updateFields.branch = gitInfo.branch;
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
  }
}
