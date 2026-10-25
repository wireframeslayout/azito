import type { PaneHandle } from '@azito/shared';
import type { ServerConfig } from '../servers/Server';
import type { IMuxClient } from '../tmux/IMuxClient';
import { DEFAULT_TERMINAL_COLS, DEFAULT_TERMINAL_ROWS } from '../tmux/terminalSize';
import type { IFileOps } from '../../shared/fs/fileOps';
import { resolveShellDirectory } from '../../shared/os/changeDirectoryLine';
import { launchArgv, type WorkerLaunch } from './WorkerLaunch';

export interface ProgramLaunchPlace {
  /** Where the worker starts: the shell's directory a POSIX pane would have been `cd`'d to. Null: the mux's default. */
  cwd: string | null;
  /**
   * The env the pane being replaced was created with (the task's token generation, the credential mask). The plaintext is stored
   * nowhere else, so the replacement can only be given it by the caller; null (not known to this call) is refused, not replaced by
   * an empty env, which would start a worker that cannot reach the hub.
   */
  paneEnv: Readonly<Record<string, string>> | null;
  /** The target host's file operations: a `~` form of `cwd` is expanded against that host's home (the mux does not expand it). */
  files: () => IFileOps;
}

/**
 * Starts a worker as a program in place of the shell pane `handle` (the way a Windows host starts one, see `workerStartsAsProgram`):
 * the program and its arguments go to the mux as they are, in the working directory and at the terminal size the UI starts with.
 * Returns the handle of the pane the worker runs in, which is a different pane of the same window.
 */
export async function launchProgramInPane(
  driver: IMuxClient,
  server: ServerConfig,
  handle: PaneHandle,
  launch: WorkerLaunch,
  place: ProgramLaunchPlace,
): Promise<PaneHandle> {
  if (place.paneEnv === null) {
    throw new Error(`Cannot start a worker in place of pane ${handle} on ${server.name}: the env the pane was created with is not known, and the replacement pane would not reach the hub without it.`);
  }
  const cwd = place.cwd === null ? null : await resolveShellDirectory(place.files, place.cwd);
  return driver.replacePaneWithProgram(server, handle, {
    argv: launchArgv(launch),
    ...(cwd !== null ? { cwd } : {}),
    cols: DEFAULT_TERMINAL_COLS,
    rows: DEFAULT_TERMINAL_ROWS,
    extraEnv: { ...place.paneEnv },
  });
}
