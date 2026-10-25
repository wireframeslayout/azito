import { type PaneHandle } from '@azito/shared';
import type { IMuxClient } from '../../../tmux/IMuxClient';
import type { WorkerInputService } from '../WorkerInputService';
import type { WorkerWaiter } from '../WorkerWaiter';
import type { HttpSignalTurnCoordinator } from '../HttpSignalTurnCoordinator';
import type { ServerConfig } from '../../../servers/Server';
import { usesHttpSignalPath } from '../../../units/Unit';
import { renderForStateMachine } from '../../../prompt/PhasePromptRenderer';
import { FOLLOW_UP_CAPABILITY, stateMachineEnvelope } from '../../../prompt/executionEnvelope';
import { shouldSupervise, wrapWithSupervisor } from '../../../supervisors/SupervisorLaunch';
import type { SupervisorRegistry } from '../../../supervisors/SupervisorRegistry';
import { launchProgramInPane } from '../../../agents/launchProgramInPane';
import { renderLaunchLine } from '../../../agents/WorkerLaunch';
import type {
  IWorkerRuntime,
  WorkerLaunchContext,
  WorkerLaunchResult,
  WorkerContext,
  EnvelopeBuildContext,
  EnvelopeBuildResult,
  FollowUpEnvelopeBuildContext,
} from './IWorkerRuntime';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isClaudeLaunchCommand(command: string): boolean {
  return /\bclaude\b/i.test(command) && !/\bcodex\b/i.test(command);
}

export class TuiNotReadyError extends Error {
  constructor(public readonly trustDialogDetected: boolean, public readonly lastScreen: string) {
    super(
      trustDialogDetected
        ? 'Claude Code の信頼確認ダイアログで起動が停止しました'
        : 'Claude Code TUI did not become ready within 30s',
    );
    this.name = 'TuiNotReadyError';
  }
}

function hasTrustDialog(output: string): boolean {
  const stripped = output.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '').toLowerCase();
  return stripped.includes('trust this folder') ||
    (stripped.includes('no,') && stripped.includes('exit') && stripped.includes('yes,') && stripped.includes('trust'));
}

function isTuiReady(output: string): boolean {
  const stripped = output.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
  const lower = stripped.toLowerCase();
  if (
    lower.includes('bypass permissions') ||
    lower.includes('shift+tab to cycle') ||
    lower.includes('esc to interrupt')
  ) {
    return true;
  }
  return stripped.includes('/help') && /Claude/i.test(stripped);
}

export class TuiWorkerRuntime implements IWorkerRuntime {
  constructor(
    private workerInput: WorkerInputService,
    private workerWaiter: WorkerWaiter,
    private httpSignalCoordinator: HttpSignalTurnCoordinator,
    private supervisorRegistry: Pick<SupervisorRegistry, 'issueLaunch'>,
    private harnessPrefix?: string,
  ) {}

  async launch(ctx: WorkerLaunchContext): Promise<WorkerLaunchResult> {
    const line = renderLaunchLine(ctx.launch, ctx.dialect);
    const supervised = shouldSupervise(ctx.server.type, ctx.windowType, ctx.windowKind);
    let command = line;
    let handle = ctx.handle;
    if (ctx.startsAsProgram) {
      // The mux starts the program itself; a supervisor wraps a typed line, so it has nothing to wrap here (and a windows host has no tmux pane to supervise).
      if (supervised) throw new Error(`A worker started as a program cannot run under a supervisor (${ctx.server.name}, window kind ${ctx.windowKind}).`);
      handle = await launchProgramInPane(ctx.driver, ctx.server, ctx.handle, ctx.launch, { cwd: ctx.cwd, paneEnv: ctx.paneEnv });
    } else {
      command = supervised
        ? wrapWithSupervisor(line, {
            server: ctx.server,
            dialect: ctx.dialect,
            target: ctx.supervisorTarget,
            taskId: ctx.taskId,
            unitId: ctx.unitId,
            harnessPrefix: this.harnessPrefix,
            // Issue #28 Phase C — issueLaunch() returns undefined only when no
            // DB-backed launch repository exists (see its doc comment); the
            // spread then omits both flags and wrapWithSupervisor falls back to
            // an unbound launch, exactly the pre-Phase-C command shape.
            ...this.supervisorRegistry.issueLaunch({
              serverName: ctx.server.name,
              target: ctx.supervisorTarget,
              taskId: ctx.taskId ?? null,
              unitId: ctx.unitId ?? null,
              windowId: ctx.windowId ?? null,
            }),
          })
        : line;
      await ctx.driver.sendKeysToHandle(ctx.server, ctx.handle, [command, 'Enter']);
    }
    const isClaudeWorker = isClaudeLaunchCommand(line);
    await this.waitForTuiReady(ctx.driver, ctx.server, handle, isClaudeWorker);
    return { command, handle };
  }

  private async waitForTuiReady(driver: IMuxClient, server: ServerConfig, handle: PaneHandle, strict: boolean): Promise<void> {
    await sleep(3000);

    if (!strict) return;

    let lastScreen = '';
    const deadline = Date.now() + 27000;
    while (Date.now() < deadline) {
      const result = await driver.captureScreen(server, handle, -50);
      lastScreen = result.stdout;
      if (isTuiReady(lastScreen)) return;
      if (hasTrustDialog(lastScreen)) {
        throw new TuiNotReadyError(true, lastScreen);
      }
      await sleep(1000);
    }

    throw new TuiNotReadyError(hasTrustDialog(lastScreen), lastScreen);
  }

  async sendPrompt(ctx: WorkerContext, prompt: string): Promise<void> {
    await this.workerInput.sendPrompt(
      ctx.server,
      ctx.handle,
      prompt,
      { taskId: ctx.taskId, unitId: ctx.unitId },
      ctx.supervisorTarget,
    );
  }

  buildEnvelope(ctx: EnvelopeBuildContext): EnvelopeBuildResult {
    const httpSignalMode = usesHttpSignalPath(ctx.workerExecutionMode);

    if (httpSignalMode) {
      const started = this.httpSignalCoordinator.start({
        taskId: ctx.taskId,
        unitId: ctx.unitId,
        kind: 'phase',
        phase: ctx.phase,
        capability: ctx.capability,
        nonce: ctx.nonce,
        server: ctx.server,
        target: ctx.handle,
        prompt: ctx.prompt,
        outputFilePath: ctx.outputFilePath,
      });
      return {
        markerizedPrompt: started.markerizedPrompt,
        signalStream: started.signalStream,
        httpSignalTurn: started.turn,
      };
    }

    const signalStream = this.workerWaiter.startSignalStream(
      ctx.server,
      ctx.tempServer,
      ctx.taskId,
      ctx.unitId,
      ctx.doneMarker,
      ctx.questionsMarker,
    );
    const signalFilePath = signalStream.getFilePath();
    const markerizedPrompt = renderForStateMachine(ctx.prompt, {
      phase: ctx.phase,
      capability: ctx.capability,
      doneMarker: ctx.doneMarker,
      questionsMarker: ctx.questionsMarker,
      testFailedMarker: ctx.testFailedMarker,
      signalFilePath,
      outputFilePath: ctx.outputFilePath,
    });
    return { markerizedPrompt, signalStream, httpSignalTurn: null };
  }

  buildFollowUpEnvelope(ctx: FollowUpEnvelopeBuildContext): EnvelopeBuildResult {
    const httpSignalMode = usesHttpSignalPath(ctx.workerExecutionMode);

    if (httpSignalMode) {
      const started = this.httpSignalCoordinator.start({
        taskId: ctx.taskId,
        unitId: ctx.unitId,
        kind: 'follow_up',
        phase: null,
        capability: FOLLOW_UP_CAPABILITY,
        nonce: ctx.nonce,
        server: ctx.server,
        target: ctx.handle,
        prompt: ctx.prompt,
        outputFilePath: ctx.outputFilePath,
      });
      return {
        markerizedPrompt: started.markerizedPrompt,
        signalStream: started.signalStream,
        httpSignalTurn: started.turn,
      };
    }

    const signalStream = this.workerWaiter.startSignalStream(
      ctx.server,
      ctx.tempServer,
      ctx.taskId,
      ctx.unitId,
      ctx.doneMarker,
      ctx.questionsMarker,
    );
    const signalFilePath = signalStream.getFilePath();
    const completionSignalBlock = stateMachineEnvelope({
      phase: 'follow_up',
      capability: FOLLOW_UP_CAPABILITY,
      doneMarker: ctx.doneMarker,
      questionsMarker: ctx.questionsMarker,
      testFailedMarker: ctx.testFailedMarker,
      signalFilePath,
      outputFilePath: ctx.outputFilePath,
    }).wrap('');
    const markerizedPrompt = ctx.prompt + completionSignalBlock;
    return { markerizedPrompt, signalStream, httpSignalTurn: null };
  }

  async resume(ctx: WorkerLaunchContext): Promise<WorkerLaunchResult> {
    return this.launch(ctx);
  }
}
