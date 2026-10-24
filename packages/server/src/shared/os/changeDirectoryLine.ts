import type { IFileOps } from '../fs/fileOps';
import { isHomeRelativePath, pathApiFor } from './hostPath';
import type { ShellDialect } from './shellDialect';

/**
 * A path as a pane's shell must be given it. A leading `~` (`~/x`, and `~\x` on win32) is a supported form of a stored working
 * directory, but `ShellDialect.changeDirectory` quotes its argument, so neither `cd -- '~/x'` nor `Set-Location -LiteralPath '~\x'`
 * expands it. It is resolved here, once, against the host's home directory by the host's own file operations (the same idea as
 * `resolveGitPath` for git). Only the home is looked up: the rest is not required to exist and is not followed through links.
 * Any other path passes through untouched. `files` is only asked for when the path starts like a home-relative one, so an
 * absolute path never costs a round trip.
 */
export async function resolveShellDirectory(files: () => IFileOps, dir: string): Promise<string> {
  if (dir[0] !== '~') return dir;
  const ops = files();
  if (!isHomeRelativePath(ops.platform, dir)) return dir;
  const home = await ops.realpath('~');
  // After the `~`, only the host's own separators go: a backslash is a name character on POSIX.
  const rest = dir.slice(1).replace(ops.platform === 'win32' ? /^[\\/]+/ : /^\/+/, '');
  return rest === '' ? home : pathApiFor(ops.platform).join(home, rest);
}

/** The line that makes the pane's shell enter `dir` (a `~` form is expanded first, see {@link resolveShellDirectory}). */
export async function changeDirectoryLine(files: () => IFileOps, dialect: ShellDialect, dir: string): Promise<string> {
  return dialect.changeDirectory(await resolveShellDirectory(files, dir));
}
