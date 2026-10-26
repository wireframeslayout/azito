import { type PaneHandle } from '@azito/shared';
import type { IMuxClient } from '../../../tmux/IMuxClient';
import { WorkerNotRunningError, type WorkerInputService } from '../WorkerInputService';
import type { PromptFileDelivery } from '../PromptFileDelivery';
import { blockingWorkerDialog, isWorkerScreenReady, tuiAgentKindOf, type TuiAgentKind, type WorkerDialog } from './workerScreen';
import type { WorkerWaiter } from '../WorkerWaiter';
import type { HttpSignalTurnCoordinator } from '../HttpSignalTurnCoordinator';
import type { ServerConfig } from '../../../servers/Server';
import { usesHttpSignalPath } from '../../../units/Unit';
import { renderForStateMachine } from '../../../prompt/PhasePromptRenderer';
import { FOLLOW_UP_CAPABILITY, stateMachineEnvelope } from '../../../prompt/executionEnvelope';
import { shouldSupervise, wrapWithSupervisor } from '../../../supervisors/SupervisorLaunch';
import { isBareShellCommand } from '../../../../shared/os/shellCommands';
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

/** Why the worker's screen did not take a prompt: a dialog that waits for a person, the worker back at a shell, or nothing recognisable within the time allowed. */
export type TuiNotReadyReason = WorkerDialog | 'worker_exited_to_shell' | 'timeout';

const NOT_READY_MESSAGES: Record<TuiNotReadyReason, string> = {
  trust_dialog: 'Claude Code の信頼確認ダイアログで起動が停止しました',
  bypass_permissions_dialog: 'Claude Code の Bypass Permissions mode の確認ダイアログで起動が停止しました',
  codex_update_prompt: 'Codex の更新の確認画面で起動が停止しました',
  codex_trust_prompt: 'Codex のフォルダー信頼の確認画面で起動が停止しました',
  worker_exited_to_shell: 'ワーカーが終了してシェルに戻っています',
  timeout: 'The worker TUI did not become ready within 30s',
};

export class TuiNotReadyError extends Error {
  constructor(public readonly reason: TuiNotReadyReason, public readonly lastScreen: string) {
    super(NOT_READY_MESSAGES[reason]);
    this.name = 'TuiNotReadyError';
  }
}

/**
 * `worker_not_ready: <reason>` when `err` is the worker not being able to take input (a dialog on its screen, back at a shell, never
 * ready), else null. The task is stopped with this reason and nothing is typed into the pane.
 */
export function workerNotReadyReason(err: unknown): string | null {
  if (err instanceof TuiNotReadyError) return `worker_not_ready: ${err.reason}`;
  if (err instanceof WorkerNotRunningError) return 'worker_not_ready: worker_exited_to_shell';
  return null;
}

/** The screen the readiness checks read: the pane's last lines. */
const SCREEN_CAPTURE_LINES = -50;

export class TuiWorkerRuntime implements IWorkerRuntime {
  constructor(
    private workerInput: WorkerInputService,
    private workerWaiter: WorkerWaiter,
    private httpSignalCoordinator: HttpSignalTurnCoordinator,
    private supervisorRegistry: Pick<SupervisorRegistry, 'issueLaunch'>,
    private harnessPrefix: string,
    private promptFiles: PromptFileDelivery,
  ) {}

  async launch(ctx: WorkerLaunchContext): Promise<string> {
    if (ctx.startedAsProgram) {
      // The window was created with the worker as its pane: there is nothing to type, only the TUI to wait for.
      await this.waitForTuiReady(ctx.driver, ctx.server, ctx.handle, tuiAgentKindOf(ctx.effectiveLaunchCommand));
      return ctx.effectiveLaunchCommand;
    }
    const sendCommand = shouldSupervise(ctx.server.type, ctx.windowType, ctx.windowKind)
      ? wrapWithSupervisor(ctx.effectiveLaunchCommand, {
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
      : ctx.effectiveLaunchCommand;
    await ctx.driver.sendKeysToHandle(ctx.server, ctx.handle, [sendCommand, 'Enter']);
    await this.waitForTuiReady(ctx.driver, ctx.server, ctx.handle, tuiAgentKindOf(ctx.effectiveLaunchCommand));
    return sendCommand;
  }

  /** Waits until the agent's input screen is up; a dialog on it, or no sign of it within 30s, is a {@link TuiNotReadyError}. A generic worker has no screen to read. */
  private async waitForTuiReady(driver: IMuxClient, server: ServerConfig, handle: PaneHandle, kind: TuiAgentKind | null): Promise<void> {
    await sleep(3000);

    if (kind === null) return;

    let lastScreen = '';
    const deadline = Date.now() + 27000;
    while (Date.now() < deadline) {
      const result = await driver.captureScreen(server, handle, SCREEN_CAPTURE_LINES);
      lastScreen = result.stdout;
      if (isWorkerScreenReady(kind, lastScreen)) return;
      const dialog = blockingWorkerDialog(kind, lastScreen);
      if (dialog) throw new TuiNotReadyError(dialog, lastScreen);
      // The agent ended and left the pane at a shell: nothing will ever be ready, and a prompt typed now would be read by the shell.
      const foreground = await driver.paneCommandByHandle(server, handle);
      if (foreground !== null && isBareShellCommand(foreground)) throw new TuiNotReadyError('worker_exited_to_shell', lastScreen);
      await sleep(1000);
    }

    throw new TuiNotReadyError('timeout', lastScreen);
  }

  /**
   * Types the instruction to read the prompt's file into the worker, never the prompt (Issue #532). Before that the screen is read: a
   * dialog on it (the worker would take the line as an answer to it) stops the task with a reason and nothing is sent. A worker that
   * has gone back to a shell is refused by WorkerInputService.sendPrompt (`WorkerNotRunningError`), also before anything is typed.
   */
  async sendPrompt(ctx: WorkerContext, prompt: string): Promise<void> {
    if (ctx.agentKind !== null) {
      const screen = (await ctx.driver.captureScreen(ctx.server, ctx.handle, SCREEN_CAPTURE_LINES)).stdout;
      const dialog = blockingWorkerDialog(ctx.agentKind, screen);
      if (dialog) throw new TuiNotReadyError(dialog, screen);
    }
    const instruction = await this.promptFiles.stage(ctx.server, ctx.taskId, ctx.unitId, prompt);
    await this.workerInput.sendPrompt(
      ctx.server,
      ctx.handle,
      instruction,
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
        host: ctx.host,
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
      host: ctx.host,
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
        host: ctx.host,
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
      host: ctx.host,
    }).wrap('');
    const markerizedPrompt = ctx.prompt + completionSignalBlock;
    return { markerizedPrompt, signalStream, httpSignalTurn: null };
  }

  async resume(ctx: WorkerLaunchContext): Promise<string> {
    return this.launch(ctx);
  }
}
