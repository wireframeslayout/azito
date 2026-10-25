import { randomUUID } from 'node:crypto';
import type { IFileOps } from '../../shared/fs/fileOps';
import { resolveShellDirectory } from '../../shared/os/changeDirectoryLine';
import type { PaneProgram } from '../tmux/IMuxClient';
import { DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS } from '../tmux/terminalSize';
import type { ISessionStrategyFactory } from './SessionStrategy';
import { commandLineLaunch, launchArgv, withFlags, type WorkerLaunch } from './WorkerLaunch';

/**
 * The first pane of a window that a Windows host starts a worker in (#371): the program and its arguments as the argv of misao's
 * `pane.open`, in `cwd` (a `~` form is expanded against the host's home, which the mux does not do) and at the terminal size the UI
 * starts with (a Node TUI does not follow a later ConPTY resize). Nothing is typed into a shell, and no shell pane is made first and
 * replaced: the window is created with the worker as its pane.
 */
export async function programFor(launch: WorkerLaunch, cwd: string | null, files: () => IFileOps): Promise<PaneProgram> {
  const argv = launchArgv(launch);
  const resolved = cwd === null ? null : await resolveShellDirectory(files, cwd);
  return { argv, ...(resolved !== null ? { cwd: resolved } : {}), cols: DEFAULT_TERMINAL_COLS, rows: DEFAULT_TERMINAL_ROWS };
}

export interface NewWindowProgramRequest {
  /** The command the Add Window form built (`claude --dangerously-skip-permissions --model 'x'`, or a custom one). */
  command: string;
  workerType: string | null;
  workingDirectory: string | null;
}

/**
 * The program of a new window for a manually added agent: the form's command, with a session id of its own when the agent takes one at
 * launch (the same rule as typing the command into a POSIX pane). Returns the session id to record on the window, null for an agent
 * that has none (or whose id is found after launch).
 */
export async function planNewWindowProgram(
  strategies: ISessionStrategyFactory,
  files: () => IFileOps,
  request: NewWindowProgramRequest,
): Promise<{ program: PaneProgram; agentSessionId: string | null }> {
  const strategy = strategies.create(request.workerType);
  let launch: WorkerLaunch = commandLineLaunch(request.command.trim());
  let agentSessionId: string | null = null;
  if (strategy.supportsSession && !strategy.needsPostLaunchScan) {
    agentSessionId = /(?:^|\s)--session-id\s+(\S+)/.exec(request.command)?.[1] ?? /(?:^|\s)--resume\s+(\S+)/.exec(request.command)?.[1] ?? null;
    if (agentSessionId === null) {
      agentSessionId = randomUUID();
      const args = strategy.buildNewSessionArgs(agentSessionId);
      if (args.length === 0) agentSessionId = null;
      else launch = withFlags(launch, args);
    }
  }
  return { program: await programFor(launch, request.workingDirectory, files), agentSessionId };
}
