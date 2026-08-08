import type { TmuxClient } from '../../../tmux/TmuxClient';
import type { WorkerInputService } from '../WorkerInputService';
import type { WorkerWaiter } from '../WorkerWaiter';
import type { HttpSignalTurnCoordinator } from '../HttpSignalTurnCoordinator';
import type { ServerConfig } from '../../../servers/Server';
import { usesHttpSignalPath } from '../../../units/Unit';
import { renderForStateMachine } from '../../../prompt/PhasePromptRenderer';
import { FOLLOW_UP_CAPABILITY, stateMachineEnvelope } from '../../../prompt/executionEnvelope';
import { shouldSupervise, wrapWithSupervisor } from '../../../supervisors/SupervisorLaunch';
import type { SupervisorRegistry } from '../../../supervisors/SupervisorRegistry';
import type {
  IWorkerRuntime,
  WorkerLaunchContext,
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
    private tmux: TmuxClient,
    private workerInput: WorkerInputService,
    private workerWaiter: WorkerWaiter,
    private httpSignalCoordinator: HttpSignalTurnCoordinator,
    private supervisorRegistry: Pick<SupervisorRegistry, 'issueLaunch'>,
  ) {}

  async launch(ctx: WorkerLaunchContext): Promise<string> {
    const sendCommand = shouldSupervise(ctx.server.type, ctx.windowType)
      ? wrapWithSupervisor(ctx.effectiveLaunchCommand, {
          server: ctx.server,
          target: ctx.supervisorTarget,
          taskId: ctx.taskId,
          unitId: ctx.unitId,
          // Issue #28 Phase C — issueLaunch() returns undefined only when no
          // DB-backed launch repository exists (see its doc comment); the
          // spread then omits both flags and wrapWithSupervisor falls back to
          // an unbound launch, exactly the pre-Phase-C command shape.
          ...this.supervisorRegistry.issueLaunch({
            serverName: ctx.server.name,
            target: ctx.supervisorTarget,
            taskId: ctx.taskId ?? null,
            unitId: ctx.unitId ?? null,
          }),
        })
      : ctx.effectiveLaunchCommand;
    await this.tmux.sendKeys(ctx.server, ctx.target, [sendCommand, 'Enter']);
    const isClaudeWorker = isClaudeLaunchCommand(ctx.effectiveLaunchCommand);
    await this.waitForTuiReady(ctx.server, ctx.target, isClaudeWorker);
    return sendCommand;
  }

  private async waitForTuiReady(server: ServerConfig, target: string, strict: boolean): Promise<void> {
    await sleep(3000);

    if (!strict) return;

    const deadline = Date.now() + 27000;
    while (Date.now() < deadline) {
      const result = await this.tmux.capturePane(server, target, -50);
      if (isTuiReady(result.stdout)) return;
      await sleep(1000);
    }

    throw new Error('Claude Code TUI did not become ready within 30s');
  }

  async sendPrompt(ctx: WorkerContext, prompt: string): Promise<void> {
    await this.workerInput.sendPrompt(
      ctx.server,
      ctx.target,
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
        target: ctx.target,
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
      ctx.taskId,
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
        target: ctx.target,
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
      ctx.taskId,
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

  async resume(ctx: WorkerLaunchContext): Promise<string> {
    return this.launch(ctx);
  }
}
