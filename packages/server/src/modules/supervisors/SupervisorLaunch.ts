import type { ServerConfig } from '../servers/Server';
import { resolveSupervisorCommand } from './SupervisorPath';
import { shellQuote } from '../../shared/shellQuote';

export function shouldSupervise(serverType: ServerConfig['type'], windowType: string): boolean {
  return windowType === 'agent';
}

export interface WrapWithSupervisorOptions {
  server: Pick<ServerConfig, 'name' | 'type'>;
  target: string;
  taskId?: number;
  unitId?: number;
}

/**
 * Wraps a worker launch command with `tui-supervisor`, so the supervisor's
 * PTY sits between the tmux pane and the actual worker process (activity
 * tracking + prompt injection). The wrapped command is what gets typed into
 * the pane via tmux send-keys — see packages/tui-supervisor/src/cli.ts's
 * `parseArgs()`: everything after `--` is re-joined with spaces, so `cmd`
 * must be quoted as a single shell-level argument for it to survive that
 * round-trip intact (quotes/spaces/pipes preserved).
 */
export function wrapWithSupervisor(cmd: string, opts: WrapWithSupervisorOptions): string {
  const supervisorCmd = resolveSupervisorCommand(opts.server);
  const parts = [
    supervisorCmd,
    '--server',
    shellQuote(opts.server.name),
    '--target',
    shellQuote(opts.target),
  ];

  if (opts.taskId !== undefined) {
    parts.push('--task-id', String(opts.taskId));
  }
  if (opts.unitId !== undefined) {
    parts.push('--unit-id', String(opts.unitId));
  }

  parts.push('--', shellQuote(cmd));
  return parts.join(' ');
}
