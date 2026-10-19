import type { IServerTransport } from '../servers/transport/ServerTransport';
import { buildCommandSpec, type CommandResult, type CommandSpecOptions } from '../../shared/exec/commandSpec';

/**
 * Runs `git <args>` on the server's host without a shell. `cwd` replaces a leading `cd <dir> &&`; pass `undefined` when the
 * arguments carry the directory themselves (`-C <dir>`). A non-zero exit is returned (git's exit code is real), not thrown.
 */
export function runGit(
  transport: Pick<IServerTransport, 'run'>,
  cwd: string | undefined,
  args: string[],
  options: CommandSpecOptions = {},
): Promise<CommandResult> {
  return transport.run(buildCommandSpec('git', args, { ...options, ...(cwd !== undefined ? { cwd } : {}) }));
}

/** stdout and stderr of a result as one trimmed text, for an error message or a wording check. */
export function combinedOutput(result: Pick<CommandResult, 'stdout' | 'stderr'>): string {
  return `${result.stdout}\n${result.stderr}`.trim();
}
