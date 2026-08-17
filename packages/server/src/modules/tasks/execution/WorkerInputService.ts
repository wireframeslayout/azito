import type { TmuxClient } from '../../tmux/TmuxClient';
import type { ServerConfig } from '../../servers/Server';
import type { SupervisorRegistry } from '../../supervisors/SupervisorRegistry';
import { SupervisorCommandError } from '../../supervisors/SupervisorRegistry';
import type { LogType } from '../ExecutionLog';

export interface WorkerInputContext {
  taskId: number;
  unitId: number;
}

// Duplicated from WorkerWaiter.ts's identical `AppendLogFn` (rather than
// importing it) to avoid a WorkerInputService <-> WorkerWaiter import cycle —
// WorkerWaiter depends on WorkerInputService (for autoConfirm), and this class
// must stay a leaf with respect to it.
export type AppendLogFn = (taskId: number, unitId: number, type: LogType, content: unknown) => void;

// Bare shells that mean the worker process is gone: when a supervisor dies it
// takes its child worker with it, dropping the pane back to the login shell.
// Kept in sync with AgentActivityMonitor's SHELL_COMMANDS — duplicated rather
// than imported because modules/operations already depends on modules/tasks
// (AgentActivityMonitor imports ExecuteTaskUseCase); importing back would cycle.
const SHELL_COMMANDS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash']);

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
    private tmux: TmuxClient,
    private registry: SupervisorRegistry,
    private appendLog: AppendLogFn,
  ) {}

  async sendPrompt(
    server: ServerConfig,
    target: string,
    text: string,
    ctx?: WorkerInputContext,
    supervisorTarget?: string,
  ): Promise<void> {
    const supervisorKey = supervisorTarget ?? target;
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
      const foreground = await this.tmux.getPaneCurrentCommand(server, target);
      if (foreground !== null && SHELL_COMMANDS.has(foreground)) {
        if (ctx) {
          this.appendLog(ctx.taskId, ctx.unitId, 'command', {
            type: 'supervisor_inject_aborted_dead_worker',
            foreground,
          });
        }
        return;
      }
    }
    await this.tmux.sendKeys(server, target, [text, 'Enter']);
  }

  async sendKeys(
    server: ServerConfig,
    target: string,
    keys: string[],
    ctx?: WorkerInputContext,
    supervisorTarget?: string,
  ): Promise<void> {
    const supervisorKey = supervisorTarget ?? target;
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
    await this.tmux.sendKeys(server, target, keys);
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
