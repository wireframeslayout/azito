import type { PaneHandle } from '@azito/shared';
import type { IMuxClient } from '../../tmux/IMuxClient';
import type { MuxDriverRegistry } from '../../tmux/MuxDriverRegistry';
import type { ServerConfig } from '../../servers/Server';
import type { SupervisorRegistry } from '../../supervisors/SupervisorRegistry';
import { SupervisorCommandError } from '../../supervisors/SupervisorRegistry';
import type { LogType } from '../ExecutionLog';
import { isBareShellCommand } from '../../../shared/os/shellCommands';

export interface WorkerInputContext {
  taskId: number;
  unitId: number;
}

// Duplicated from WorkerWaiter.ts's identical `AppendLogFn` (rather than
// importing it) to avoid a WorkerInputService <-> WorkerWaiter import cycle —
// WorkerWaiter depends on WorkerInputService (for autoConfirm), and this class
// must stay a leaf with respect to it.
export type AppendLogFn = (taskId: number, unitId: number, type: LogType, content: unknown) => void;

export class WorkerNotRunningError extends Error {
  constructor(public readonly foreground: string) {
    super(`Worker is not running (foreground: ${foreground})`);
    this.name = 'WorkerNotRunningError';
  }
}

/**
 * Routes worker input through the supervisor's PTY when a BOUND supervisor is
 * connected for the target pane, otherwise falls back to tmux send-keys.
 *
 * Issue #28 third-party review (Important): this carries task input (prompt
 * injection / key sends) into the pane, so it must apply the same "unbound
 * is display-only" contract Tier 0/turn-idle-refresh already follow
 * (SupervisorConnection.bound's doc comment) — an unbound connection's
 * claimed taskId/unitId was never verified against a persisted launch, so
 * routing this task's input to it would hand task input to an unverified
 * process. `isBoundConnected` (not `isConnected`) gates both send paths
 * below; an unbound (or absent) connection falls through to the tmux
 * send-keys path, same as "no supervisor" always has.
 */
export class WorkerInputService {
  constructor(
    private muxDriverRegistry: MuxDriverRegistry,
    private registry: SupervisorRegistry,
    private appendLog: AppendLogFn,
  ) {}

  async sendPrompt(
    server: ServerConfig,
    handle: PaneHandle,
    text: string,
    ctx?: WorkerInputContext,
    supervisorTarget?: string,
  ): Promise<void> {
    const driver = this.muxDriverRegistry.resolve(server);
    const supervisorKey = supervisorTarget ?? handle;
    if (this.registry.isBoundConnected(server.name, supervisorKey)) {
      try {
        await this.registry.sendCommand(server.name, supervisorKey, { type: 'inject_prompt', text, submit: true });
        return;
      } catch (err) {
        if (this.isAckTimeout(err)) {
          this.logAmbiguousTimeout(ctx, err.message);
          return;
        }
        this.logFallback(ctx, (err as Error).message);
      }
    }

    // Guard against sending to a bare shell — covers both the supervisor
    // fallback path (sendCommand failed) and the no-supervisor path.
    await this.assertNotAtShell(driver, server, handle, ctx);

    await driver.sendKeysToHandle(server, handle, [text, 'Enter']);
  }

  /**
   * Types `text` into the pane without submitting it: pasted by the supervisor (`inject_prompt` with `submit: false`) when the pane has a
   * bound one, else as keys. The Enter is `submitPrompt`, sent when the text has been seen in the worker's input, because an Enter that
   * reaches codex before its input has drawn the text is not a submit. A supervisor's ack timeout is taken as typed (the screen says);
   * a failed supervisor falls back to keys. The keys path is refused, with nothing typed, for a pane at a bare shell (the supervisor path has
   * no such check here: the runtime looks at the pane before it writes anything).
   */
  async typePrompt(server: ServerConfig, handle: PaneHandle, text: string, ctx?: WorkerInputContext, supervisorTarget?: string): Promise<void> {
    const driver = this.muxDriverRegistry.resolve(server);
    const supervisorKey = supervisorTarget ?? handle;
    if (this.registry.isBoundConnected(server.name, supervisorKey)) {
      try {
        // Pasted, not submitted: the Enter is a command of its own, after the worker's input has been seen to hold the text.
        await this.registry.sendCommand(server.name, supervisorKey, { type: 'inject_prompt', text, submit: false });
        return;
      } catch (err) {
        if (this.isAckTimeout(err)) {
          this.logAmbiguousTimeout(ctx, err.message);
          return;
        }
        this.logFallback(ctx, (err as Error).message);
      }
    }
    await this.assertNotAtShell(driver, server, handle, ctx);
    await driver.sendKeysToHandle(server, handle, [text]);
  }

  /** The Enter that submits what `typePrompt` typed (through the supervisor when the pane has one, as every key of a supervised pane goes). */
  async submitPrompt(server: ServerConfig, handle: PaneHandle, ctx?: WorkerInputContext, supervisorTarget?: string): Promise<void> {
    await this.sendKeys(server, handle, ['Enter'], ctx, supervisorTarget);
  }

  /**
   * Clears the line of the input (Ctrl+U), straight to the pane: the supervisor's key names do not include it. For taking back the
   * line a stopped task typed, so that nothing submits it later.
   */
  async clearInputLine(server: ServerConfig, handle: PaneHandle): Promise<void> {
    await this.muxDriverRegistry.resolve(server).sendKeysToHandle(server, handle, ['C-u']);
  }

  async sendKeys(
    server: ServerConfig,
    handle: PaneHandle,
    keys: string[],
    ctx?: WorkerInputContext,
    supervisorTarget?: string,
  ): Promise<void> {
    const driver = this.muxDriverRegistry.resolve(server);
    const supervisorKey = supervisorTarget ?? handle;
    if (this.registry.isBoundConnected(server.name, supervisorKey)) {
      try {
        await this.registry.sendCommand(server.name, supervisorKey, { type: 'send_keys', keys });
        return;
      } catch (err) {
        if (this.isAckTimeout(err)) {
          this.logAmbiguousTimeout(ctx, err.message);
          return;
        }
        this.logFallback(ctx, (err as Error).message);
      }
    }
    await driver.sendKeysToHandle(server, handle, keys);
  }

  private async assertNotAtShell(driver: IMuxClient, server: ServerConfig, handle: PaneHandle, ctx?: WorkerInputContext): Promise<void> {
    const foreground = await driver.paneCommandByHandle(server, handle);
    if (foreground !== null && isBareShellCommand(foreground)) {
      if (ctx) {
        this.appendLog(ctx.taskId, ctx.unitId, 'command', {
          type: 'send_aborted_dead_worker',
          foreground,
        });
      }
      throw new WorkerNotRunningError(foreground);
    }
  }

  private isAckTimeout(err: unknown): err is SupervisorCommandError {
    return err instanceof SupervisorCommandError && err.reason === 'ack_timeout';
  }

  private logFallback(ctx: WorkerInputContext | undefined, reason: string): void {
    if (!ctx) return;
    this.appendLog(ctx.taskId, ctx.unitId, 'command', { type: 'supervisor_inject_fallback', reason });
  }

  private logAmbiguousTimeout(ctx: WorkerInputContext | undefined, reason: string): void {
    if (!ctx) return;
    this.appendLog(ctx.taskId, ctx.unitId, 'command', { type: 'supervisor_inject_ambiguous_timeout', reason });
  }
}
