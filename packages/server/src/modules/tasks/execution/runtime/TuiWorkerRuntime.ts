import { type PaneHandle } from '@azito/shared';
import type { IMuxClient } from '../../../tmux/IMuxClient';
import { WorkerNotRunningError, type WorkerInputService } from '../WorkerInputService';
import type { PromptFileDelivery } from '../PromptFileDelivery';
import { getAgentTranscriptProfile } from '../../../transcripts/sources/profiles';
import { blockingWorkerDialog, detectWorkerDialog, hasStalePromptInInput, isPromptPendingInInput, isWorkerScreenReady, tuiAgentKindOf, type TuiAgentKind, type WorkerDialog } from './workerScreen';
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
export type TuiNotReadyReason = WorkerDialog | 'worker_exited_to_shell' | 'not_ready' | 'input_not_empty' | 'prompt_not_submitted' | 'timeout';

const NOT_READY_MESSAGES: Record<TuiNotReadyReason, string> = {
  trust_dialog: 'Claude Code の信頼確認ダイアログが出ているため、プロンプトを送らずにタスクを止めました',
  bypass_permissions_dialog: 'Claude Code の Bypass Permissions mode の確認ダイアログが出ているため、プロンプトを送らずにタスクを止めました',
  codex_update_prompt: 'Codex の更新の確認画面が出ているため、プロンプトを送らずにタスクを止めました',
  codex_trust_prompt: 'Codex のフォルダー信頼の確認画面が出ているため、プロンプトを送らずにタスクを止めました',
  worker_exited_to_shell: 'ワーカーが終了してシェルに戻っているため、プロンプトを送らずにタスクを止めました',
  not_ready: 'ワーカーの画面が入力待ちになっていない（既知の入力欄が見えない）ため、プロンプトを送らずにタスクを止めました',
  input_not_empty: 'ワーカーの入力欄に前のプロンプトの 1 行が残っているため、プロンプトを送らずにタスクを止めました',
  prompt_not_submitted: 'ワーカーの入力欄に送った 1 行が残ったままで、Enter を再送しても送信されなかったため、タスクを止めました',
  timeout: 'ワーカーの画面が 30 秒以内に入力待ちにならなかったため、プロンプトを送らずにタスクを止めました',
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

/** How long the agent wants between its text and the Enter that submits it (its transcript profile; the chat's input waits the same). */
function submitDelayMsOf(kind: TuiAgentKind | null): number {
  if (kind === null) return 0;
  const profile = getAgentTranscriptProfile(kind);
  if (!profile) throw new Error(`No transcript profile for the ${kind} worker`);
  return profile.submitDelayMs;
}

/** The screen the readiness checks read: the pane's last lines. */
const SCREEN_CAPTURE_LINES = -50;

/** How long a screen that shows neither the input nor a known dialog (a worker still drawing it) gets before the prompt is refused. */
const SEND_READY_GRACE_MS = 5000;
const SEND_READY_POLL_MS = 500;

/** How long, after the Enter, the line may stay in the input before the Enter is sent once more (and, after that, the task is stopped). */
const SUBMIT_CONFIRM_MS = 3000;
const SUBMIT_CONFIRM_POLL_MS = 300;

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
   * Types the instruction to read the prompt's file into the worker, never the prompt (Issue #532). The worker has to be at its input:
   * its screen is read and must show it (a dialog, a shell, an empty or unknown screen all stop the task with a reason and nothing is
   * sent, not even the prompt file). Order: input screen confirmed (given a few seconds to finish drawing) -> prompt file written ->
   * input screen confirmed again just before the line is typed -> the line. A worker that has gone back to a shell is refused earlier
   * and, for a supervised pane, by WorkerInputService.sendPrompt (`WorkerNotRunningError`).
   */
  async sendPrompt(ctx: WorkerContext, prompt: string): Promise<void> {
    if (ctx.agentKind !== null) await this.awaitInputScreen(ctx, ctx.agentKind);
    const instruction = await this.promptFiles.stage(ctx.server, ctx.taskId, ctx.unitId, prompt);
    if (ctx.agentKind !== null) await this.assertInputScreenNow(ctx, ctx.agentKind);
    await this.workerInput.sendPrompt(
      ctx.server,
      ctx.handle,
      instruction,
      { taskId: ctx.taskId, unitId: ctx.unitId },
      ctx.supervisorTarget,
      submitDelayMsOf(ctx.agentKind),
    );
    if (ctx.agentKind !== null) await this.confirmSubmitted(ctx, ctx.agentKind, instruction);
  }

  /**
   * The line was typed and Enter pressed; the worker has taken it when it is no longer in the input. If it is still there the Enter was
   * not a submit (codex read the keys as a paste): Enter is sent once more, not the prompt again. Still there after that, the task is
   * stopped (`prompt_not_submitted`): going on would send the next phase's line after this one.
   */
  private async confirmSubmitted(ctx: WorkerContext, kind: TuiAgentKind, instruction: string): Promise<void> {
    let screen = '';
    for (const resendEnter of [true, false]) {
      const deadline = Date.now() + SUBMIT_CONFIRM_MS;
      for (;;) {
        screen = (await ctx.driver.captureScreen(ctx.server, ctx.handle, SCREEN_CAPTURE_LINES)).stdout;
        if (!isPromptPendingInInput(kind, screen, instruction)) return;
        if (Date.now() >= deadline) break;
        await sleep(SUBMIT_CONFIRM_POLL_MS);
      }
      if (resendEnter) await ctx.driver.sendKeysToHandle(ctx.server, ctx.handle, ['Enter']);
    }
    throw new TuiNotReadyError('prompt_not_submitted', screen);
  }

  private async awaitInputScreen(ctx: WorkerContext, kind: TuiAgentKind): Promise<void> {
    const deadline = Date.now() + SEND_READY_GRACE_MS;
    for (;;) {
      const screen = (await ctx.driver.captureScreen(ctx.server, ctx.handle, SCREEN_CAPTURE_LINES)).stdout;
      // A line an earlier prompt left in the input would be sent together with this one.
      if (hasStalePromptInInput(kind, screen)) throw new TuiNotReadyError('input_not_empty', screen);
      if (isWorkerScreenReady(kind, screen)) return;
      const dialog = detectWorkerDialog(kind, screen);
      if (dialog) throw new TuiNotReadyError(dialog, screen);
      const foreground = await ctx.driver.paneCommandByHandle(ctx.server, ctx.handle);
      if (foreground !== null && isBareShellCommand(foreground)) throw new TuiNotReadyError('worker_exited_to_shell', screen);
      if (Date.now() >= deadline) throw new TuiNotReadyError('not_ready', screen);
      await sleep(SEND_READY_POLL_MS);
    }
  }

  private async assertInputScreenNow(ctx: WorkerContext, kind: TuiAgentKind): Promise<void> {
    const screen = (await ctx.driver.captureScreen(ctx.server, ctx.handle, SCREEN_CAPTURE_LINES)).stdout;
    if (hasStalePromptInInput(kind, screen)) throw new TuiNotReadyError('input_not_empty', screen);
    if (isWorkerScreenReady(kind, screen)) return;
    throw new TuiNotReadyError(detectWorkerDialog(kind, screen) ?? 'not_ready', screen);
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
