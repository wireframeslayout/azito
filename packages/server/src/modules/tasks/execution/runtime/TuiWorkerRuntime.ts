import { type PaneHandle } from '@azito/shared';
import type { IMuxClient } from '../../../tmux/IMuxClient';
import { WorkerNotRunningError, type WorkerInputService } from '../WorkerInputService';
import type { PromptFileDelivery } from '../PromptFileDelivery';
import { getAgentTranscriptProfile } from '../../../transcripts/sources/profiles';
import { blockingWorkerDialog, detectWorkerDialog, inputHoldsLine, type InputBox, isWorkerBusy, isWorkerScreenReady, readInputBox, screenAboveInput, showsTurnEnd, tuiAgentKindOf, type TuiAgentKind, type WorkerDialog } from './workerScreen';
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
export type TuiNotReadyReason = WorkerDialog | 'worker_exited_to_shell' | 'not_ready' | 'input_not_empty' | 'prompt_not_typed' | 'prompt_not_submitted' | 'input_state_unknown' | 'worker_busy' | 'timeout';

const NOT_READY_MESSAGES: Record<TuiNotReadyReason, string> = {
  trust_dialog: 'Claude Code の信頼確認ダイアログが出ているため、プロンプトを送らずにタスクを止めました',
  bypass_permissions_dialog: 'Claude Code の Bypass Permissions mode の確認ダイアログが出ているため、プロンプトを送らずにタスクを止めました',
  codex_update_prompt: 'Codex の更新の確認画面が出ているため、プロンプトを送らずにタスクを止めました',
  codex_trust_prompt: 'Codex のフォルダー信頼の確認画面が出ているため、プロンプトを送らずにタスクを止めました',
  worker_exited_to_shell: 'ワーカーが終了してシェルに戻っているため、プロンプトを送らずにタスクを止めました',
  not_ready: 'ワーカーの画面が入力待ちになっていない（既知の入力欄が見えない）ため、プロンプトを送らずにタスクを止めました',
  input_not_empty: 'ワーカーの入力欄に文字（前の 1 行や利用者の下書き）が残っているため、プロンプトを送らずにタスクを止めました',
  prompt_not_typed: '送った 1 行がワーカーの入力欄に描かれなかったため、Enter を送らずにタスクを止めました',
  prompt_not_submitted: 'ワーカーの入力欄に送った 1 行が残ったままで、Enter を再送しても送信されなかったため、タスクを止めました',
  input_state_unknown: 'ワーカーの入力欄の状態を読み取れないまま時間切れになったため、送信できたと判断せずにタスクを止めました',
  worker_busy: 'ワーカーの前のターンが 60 秒待っても終わらなかったため、プロンプトを割り込ませずにタスクを止めました',
  timeout: 'ワーカーの画面が 30 秒以内に入力待ちにならなかったため、プロンプトを送らずにタスクを止めました',
};

export class TuiNotReadyError extends Error {
  /**
   * `inputLeft`: the input was not seen empty when the task was stopped after the line was typed. Either the line is still in it, or
   * something else is, or it could not be read (`inputUnreadable`, a dialog or an overlay on the screen): whoever resumes must look at it
   * first, and clear it, or the next Enter submits what is left.
   */
  constructor(
    public readonly reason: TuiNotReadyReason,
    public readonly lastScreen: string,
    public readonly inputLeft = false,
    public readonly inputUnreadable = false,
  ) {
    super(
      !inputLeft
        ? NOT_READY_MESSAGES[reason]
        : `${NOT_READY_MESSAGES[reason]}。${inputUnreadable ? '入力欄の状態を読み取れませんでした。入力欄を確かめてから再開してください' : '入力欄に残った 1 行を消してから再開してください'}`,
    );
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

/** How long the typed line gets to show in the input (the pane relays it, on Windows through ConPTY) before Enter, and the Enter to take it. */
const LINE_DRAW_MS = 5000;
const LINE_DRAW_POLL_MS = 200;
const SUBMIT_CONFIRM_MS = 5000;
const SUBMIT_CONFIRM_POLL_MS = 300;
/** Ctrl+U clears one display line of a wrapped input on some agents (Claude Code): it is sent up to this many times, until the input is empty. */
const CLEAR_MAX_KEYS = 5;
const CLEAR_POLL_MS = 200;
/** A turn that is still running when the next prompt is due is waited for this long. */
const BUSY_WAIT_MS = 60_000;
/** A screen on which no turn was seen has to be unchanged this long before it is taken as free (one with a `Worked for` line is free at once). */
const SETTLED_MS = 5000;

interface TurnWait {
  since: number | null;
  above: string | null;
  stableSince: number;
  /** A running turn was seen during this send (a status line, or a screen that kept changing): only its `Worked for` line ends it. */
  turnSeen: boolean;
}

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
   * Delivers the prompt as one instruction line that names its file (Issue #532), and sees that the worker took it:
   *   1. the input is empty and the worker is at it, and no turn is running (a dialog, a shell, a draft, an unknown screen: stopped, nothing
   *      sent, no file; a running turn is waited for, up to 60 s in all);
   *   2. the prompt file is written; the input is looked at again, and a turn that has begun meanwhile is waited for like the first
   *      (so a stop in that second wait, after the 60 s, leaves the file: it is a task temp file, recorded and cleaned up with the task);
   *   3. the line is typed (no Enter), and waited for until the input shows it (`prompt_not_typed`): an Enter that reaches codex before
   *      the text is drawn is not a submit;
   *   4. after the agent's submit delay, Enter;
   *   5. the line is gone from the input (submitted). If it is still there, Enter once more; still there: `prompt_not_submitted`.
   * A pane under a supervisor takes the same steps: the line is pasted without a submit, and the Enter is a key command of its own. A generic worker has no screen to read:
   * the line and Enter are sent together, and a key that did not arrive shows as the wait for completion running out.
   */
  async sendPrompt(ctx: WorkerContext, prompt: string): Promise<void> {
    const kind = ctx.agentKind;
    const logCtx = { taskId: ctx.taskId, unitId: ctx.unitId };
    if (kind === null) {
      const instruction = await this.promptFiles.stage(ctx.server, ctx.taskId, ctx.unitId, prompt);
      await this.workerInput.sendPrompt(ctx.server, ctx.handle, instruction, logCtx, ctx.supervisorTarget);
      return;
    }
    // One budget for all the waiting for a turn to end, before and after the file is written.
    const turnWait: TurnWait = { since: null, above: null, stableSince: 0, turnSeen: false };
    let instruction: string | null = null;
    for (;;) {
      await this.awaitEmptyInput(ctx, kind, turnWait);
      instruction ??= await this.promptFiles.stage(ctx.server, ctx.taskId, ctx.unitId, prompt);
      // A turn that starts while the file is written is waited for as well, not a reason to stop at once.
      if (await this.inputStillFreeNow(ctx, kind)) break;
    }
    try {
      await this.workerInput.typePrompt(ctx.server, ctx.handle, instruction, logCtx, ctx.supervisorTarget);
      await this.awaitLineDrawn(ctx, kind, instruction);
      const submitDelayMs = submitDelayMsOf(kind);
      if (submitDelayMs > 0) await sleep(submitDelayMs);
      await this.workerInput.submitPrompt(ctx.server, ctx.handle, logCtx, ctx.supervisorTarget);
      await this.confirmSubmitted(ctx, kind, instruction);
    } catch (err) {
      // A stop the checks above raised has taken care of the input itself; any other error (a screen that could not be read once, a key
      // that did not go) may leave the line in the input, where the next Enter would submit what the task was stopped for.
      if (err instanceof TuiNotReadyError || err instanceof WorkerNotRunningError) throw err;
      throw await this.errorAfterTyping(ctx, kind, instruction, err);
    }
  }

  private async captureScreen(ctx: WorkerContext): Promise<string> {
    return (await ctx.driver.captureScreen(ctx.server, ctx.handle, SCREEN_CAPTURE_LINES)).stdout;
  }

  /**
   * The worker is at its input, the input is empty and no turn is running; a screen that is still drawing gets a few seconds, a turn up to
   * `BUSY_WAIT_MS` (counted over the whole send, in `turnWait`). A turn is over when its status line is gone and the screen above the input
   * has stopped changing (codex hides the line while it streams its answer and between tool calls), or when codex has written its
   * `Worked for ...` line.
   */
  private async awaitEmptyInput(ctx: WorkerContext, kind: TuiAgentKind, turnWait: TurnWait): Promise<void> {
    let deadline = Date.now() + SEND_READY_GRACE_MS;
    for (;;) {
      const screen = await this.captureScreen(ctx);
      // A pane that went back to a shell can still show the agent's last screen; nothing is written for it, and nothing typed.
      const foreground = await ctx.driver.paneCommandByHandle(ctx.server, ctx.handle);
      if (foreground !== null && isBareShellCommand(foreground)) throw new TuiNotReadyError('worker_exited_to_shell', screen);
      const dialog = detectWorkerDialog(kind, screen);
      if (dialog) throw new TuiNotReadyError(dialog, screen);
      const box = readInputBox(kind, screen);
      // Text in the input (the line of an earlier prompt, a person's draft) would be sent together with ours. It is waited on for the
      // grace like any screen that is not settled: a wording of an empty input that is not known yet reads as text, and goes away.
      if (box.state === 'empty' && isWorkerScreenReady(kind, screen)) {
        const now = Date.now();
        const above = screenAboveInput(kind, screen);
        const busy = isWorkerBusy(kind, screen);
        if (above !== turnWait.above) {
          // the screen above the input changed since the last look (not the first look): a turn is streaming
          if (turnWait.above !== null) turnWait.turnSeen = true;
          turnWait.above = above;
          turnWait.stableSince = now;
        }
        if (busy) turnWait.turnSeen = true;
        // A turn that was seen is over when its `Worked for` line is there, and only then: codex stops now and then in the middle of its
        // answer for longer than any quiet time that could be waited. A screen with no turn on it (a session just started, a turn that
        // was stopped) has no such line, and is free when it has not changed for the quiet time.
        const turnOver = !busy && (showsTurnEnd(kind, screen) || (!turnWait.turnSeen && now - turnWait.stableSince >= SETTLED_MS));
        if (turnOver) return;
        // The turn before is still running (the done marker is written in the middle of it): a prompt typed now would queue behind it or
        // cut into it. Wait for it to end; the screen's grace starts again after.
        turnWait.since ??= now;
        if (now - turnWait.since >= BUSY_WAIT_MS) throw new TuiNotReadyError('worker_busy', screen);
        deadline = now + SEND_READY_GRACE_MS;
        await sleep(SEND_READY_POLL_MS);
        continue;
      }
      if (Date.now() >= deadline) throw new TuiNotReadyError(box.state === 'filled' ? 'input_not_empty' : 'not_ready', screen);
      await sleep(SEND_READY_POLL_MS);
    }
  }

  /** The look just before the line is typed, after the file was written: true if all is as it was; false if a turn has started (back to waiting). */
  private async inputStillFreeNow(ctx: WorkerContext, kind: TuiAgentKind): Promise<boolean> {
    const screen = await this.captureScreen(ctx);
    const dialog = detectWorkerDialog(kind, screen);
    if (dialog) throw new TuiNotReadyError(dialog, screen);
    const box = readInputBox(kind, screen);
    if (box.state === 'filled') throw new TuiNotReadyError('input_not_empty', screen);
    if (box.state !== 'empty' || !isWorkerScreenReady(kind, screen)) throw new TuiNotReadyError('not_ready', screen);
    return !isWorkerBusy(kind, screen);
  }

  private async awaitLineDrawn(ctx: WorkerContext, kind: TuiAgentKind, instruction: string): Promise<void> {
    const deadline = Date.now() + LINE_DRAW_MS;
    let screen = '';
    for (;;) {
      screen = await this.captureScreen(ctx);
      if (inputHoldsLine(readInputBox(kind, screen), instruction)) return;
      if (Date.now() >= deadline) throw await this.stoppedWithInputCleared(ctx, kind, instruction, 'prompt_not_typed');
      await sleep(LINE_DRAW_POLL_MS);
    }
  }

  /**
   * Submitted = our line is no longer in the input. Still in it after the wait: Enter is sent once more (the prompt is not sent again);
   * still in it after that: `prompt_not_submitted`. An input that cannot be read until the end is not a success either (`input_state_unknown`).
   */
  private async confirmSubmitted(ctx: WorkerContext, kind: TuiAgentKind, instruction: string): Promise<void> {
    let screen = '';
    let box = readInputBox(kind, screen);
    for (const resendEnter of [true, false]) {
      const deadline = Date.now() + SUBMIT_CONFIRM_MS;
      for (;;) {
        screen = await this.captureScreen(ctx);
        box = readInputBox(kind, screen);
        if (box.state !== 'unknown' && !inputHoldsLine(box, instruction)) return;
        if (Date.now() >= deadline) break;
        await sleep(SUBMIT_CONFIRM_POLL_MS);
      }
      if (box.state === 'unknown') throw await this.stoppedWithInputCleared(ctx, kind, instruction, 'input_state_unknown');
      if (resendEnter) await this.workerInput.submitPrompt(ctx.server, ctx.handle, { taskId: ctx.taskId, unitId: ctx.unitId }, ctx.supervisorTarget);
    }
    throw await this.stoppedWithInputCleared(ctx, kind, instruction, 'prompt_not_submitted');
  }

  private async captureScreenOrNull(ctx: WorkerContext): Promise<string | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.captureScreen(ctx);
      } catch {
        await sleep(CLEAR_POLL_MS);
      }
    }
    return null;
  }

  /**
   * Looks at the input again and takes the task's line back if it is there (Ctrl+U, repeated while text is left: Claude Code clears one
   * display line of a wrapped input per key). A draft of someone else is never cleared: only a line seen to be ours. Returns what the
   * input was at the last look, or null when the screen could not be read at all.
   */
  private async clearOwnLine(ctx: WorkerContext, kind: TuiAgentKind, instruction: string): Promise<{ screen: string; box: InputBox } | null> {
    let screen = await this.captureScreenOrNull(ctx);
    if (screen === null) return null;
    let box = readInputBox(kind, screen);
    if (inputHoldsLine(box, instruction)) {
      for (let keys = 0; keys < CLEAR_MAX_KEYS && box.state !== 'empty'; keys++) {
        await this.workerInput.clearInputLine(ctx.server, ctx.handle);
        await sleep(CLEAR_POLL_MS);
        screen = (await this.captureScreenOrNull(ctx)) ?? screen;
        box = readInputBox(kind, screen);
      }
    }
    return { screen, box };
  }

  /**
   * The error that stops the task after the line was typed, with the input cleaned up (see {@link clearOwnLine}). If the input is not
   * seen empty at the end (our line could not be removed, or something else is in it, or it cannot be read), the message says to look at it
   * before resuming.
   */
  private async stoppedWithInputCleared(ctx: WorkerContext, kind: TuiAgentKind, instruction: string, reason: TuiNotReadyReason): Promise<TuiNotReadyError> {
    const left = await this.clearOwnLine(ctx, kind, instruction);
    if (left === null) return new TuiNotReadyError(reason, '', true, true);
    return new TuiNotReadyError(reason, left.screen, left.box.state !== 'empty', left.box.state === 'unknown');
  }

  /** The same for an error that is not one of the checks' (a failed look at the screen, a key that did not go): the original error is kept, with a note when the input may hold a line. */
  private async errorAfterTyping(ctx: WorkerContext, kind: TuiAgentKind, instruction: string, original: unknown): Promise<Error> {
    const error = original instanceof Error ? original : new Error(String(original));
    let left: { box: InputBox } | null = null;
    try {
      left = await this.clearOwnLine(ctx, kind, instruction);
    } catch {
      left = null;
    }
    if (left !== null && left.box.state === 'empty') return error;
    const note = left === null || left.box.state === 'unknown'
      ? '入力欄の状態を確かめられませんでした。入力欄を確かめてから再開してください'
      : '入力欄に残った 1 行を消してから再開してください';
    return new Error(`${error.message}。${note}`, { cause: error });
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
