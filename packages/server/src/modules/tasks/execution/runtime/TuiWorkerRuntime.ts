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

/** Why the Claude TUI did not become ready: a dialog that waits for a person, or nothing recognisable within the time allowed. */
export type TuiNotReadyReason = 'trust_dialog' | 'bypass_permissions_dialog' | 'timeout';

export class TuiNotReadyError extends Error {
  constructor(public readonly reason: TuiNotReadyReason, public readonly lastScreen: string) {
    super(
      reason === 'trust_dialog'
        ? 'Claude Code の信頼確認ダイアログで起動が停止しました'
        : reason === 'bypass_permissions_dialog'
          ? 'Claude Code の Bypass Permissions mode の確認ダイアログで起動が停止しました'
          : 'Claude Code TUI did not become ready within 30s',
    );
    this.name = 'TuiNotReadyError';
  }
}

function stripAnsi(output: string): string {
  return output.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
}

function hasTrustDialog(output: string): boolean {
  const stripped = stripAnsi(output).toLowerCase();
  return stripped.includes('trust this folder') ||
    (stripped.includes('no,') && stripped.includes('exit') && stripped.includes('yes,') && stripped.includes('trust'));
}

/**
 * The "Bypass Permissions mode" confirmation `claude --dangerously-skip-permissions` shows until `skipDangerousModePermissionPrompt` is
 * set. Read from the shipped binary of 2.1.310 (`BypassPermissionsModeDialog`; the 2.0.50 `cli.js` has the same texts): the title is
 * "WARNING: Claude Code running in Bypass Permissions mode", the body ends "By proceeding, you accept all responsibility for actions taken
 * while running in Bypass Permissions mode.", the choices are "No, exit" / "Yes, I accept". The body also contains "bypass permissions",
 * which is why the ready check below must exclude this screen.
 * The screen is the pane's last lines, which can also hold a conversation that quotes any one of these sentences, next to the ready status
 * line "bypass permissions on": only the title and both choices together (what no running session shows) are taken as the dialog.
 * Box-drawing characters and whitespace are collapsed because the pane wraps the dialog's lines inside a frame.
 */
function hasBypassPermissionsDialog(output: string): boolean {
  const text = stripAnsi(output).toLowerCase().replace(/[\u2500-\u257f]/g, ' ').replace(/\s+/g, ' ');
  return text.includes('warning: claude code running in bypass permissions mode') &&
    text.includes('yes, i accept') &&
    text.includes('no, exit');
}

function isTuiReady(output: string): boolean {
  if (hasBypassPermissionsDialog(output)) return false;
  const stripped = stripAnsi(output);
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

  async launch(ctx: WorkerLaunchContext): Promise<string> {
    if (ctx.startedAsProgram) {
      // The window was created with the worker as its pane: there is nothing to type, only the TUI to wait for.
      await this.waitForTuiReady(ctx.driver, ctx.server, ctx.handle, isClaudeLaunchCommand(ctx.effectiveLaunchCommand));
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
    const isClaudeWorker = isClaudeLaunchCommand(ctx.effectiveLaunchCommand);
    await this.waitForTuiReady(ctx.driver, ctx.server, ctx.handle, isClaudeWorker);
    return sendCommand;
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
      if (hasTrustDialog(lastScreen)) throw new TuiNotReadyError('trust_dialog', lastScreen);
      if (hasBypassPermissionsDialog(lastScreen)) throw new TuiNotReadyError('bypass_permissions_dialog', lastScreen);
      await sleep(1000);
    }

    throw new TuiNotReadyError('timeout', lastScreen);
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
