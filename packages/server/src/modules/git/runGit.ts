import { buildCommandSpec, CommandSpawnError, GitNotFoundError, type CommandResult, type CommandSpecOptions } from '../../shared/exec/commandSpec';
import { resolveGitPath, type GitTransport } from './gitPath';

/**
 * Where git is told to work by its global options, up to the subcommand: the index of the `-C` directory argument, or -1.
 * `-c <key=value>` takes a value of its own; any other leading option is a flag (`--no-pager`).
 */
function indexOfChangeDirectoryArg(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-C') return i + 1 < args.length ? i + 1 : -1;
    if (args[i] === '-c') { i++; continue; }
    if (!args[i].startsWith('-')) return -1;
  }
  return -1;
}

/**
 * Runs `git <args>` on the server's host without a shell. `cwd` replaces a leading `cd <dir> &&`; pass `undefined` when the
 * arguments carry the directory themselves (`-C <dir>`). A leading `~` in either is resolved against the host's home first
 * (`resolveGitPath`): git and the process's cwd do not expand it. A non-zero exit is returned (git's exit code is real), not thrown.
 */
export async function runGit(
  transport: GitTransport,
  cwd: string | undefined,
  args: string[],
  options: CommandSpecOptions = {},
): Promise<CommandResult> {
  const resolvedCwd = cwd === undefined ? undefined : await resolveGitPath(transport, cwd);
  const dirIndex = indexOfChangeDirectoryArg(args);
  const resolvedArgs = dirIndex < 0 ? args : [...args.slice(0, dirIndex), await resolveGitPath(transport, args[dirIndex]), ...args.slice(dirIndex + 1)];
  try {
    return await transport.run(buildCommandSpec('git', resolvedArgs, { ...options, ...(resolvedCwd !== undefined ? { cwd: resolvedCwd } : {}) }));
  } catch (err) {
    // A Windows agent from before R5b does not look for git.exe itself: it spawns a bare `git` and answers ENOENT when there is none.
    // Here the program is known to be git, so that answer is the same reason a current agent gives. Elsewhere ENOENT stays as it is.
    if (err instanceof CommandSpawnError && !(err instanceof GitNotFoundError) && err.code === 'ENOENT' && transport.files?.().platform === 'win32') {
      throw new GitNotFoundError(OLD_AGENT_GIT_NOT_FOUND, err.stdout, err.stderr);
    }
    throw err;
  }
}

const OLD_AGENT_GIT_NOT_FOUND =
  'Git for Windows (git.exe) was not found on this host. Install it with "winget install --id Git.Git -e", '
  + 'or update the agent if Git for Windows is already installed (an agent from before the update cannot look in the standard install locations).';

/** stdout and stderr of a result as one trimmed text, for an error message or a wording check. */
export function combinedOutput(result: Pick<CommandResult, 'stdout' | 'stderr'>): string {
  return `${result.stdout}\n${result.stderr}`.trim();
}
