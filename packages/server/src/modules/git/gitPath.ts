import { hostPathFor } from '@azito/shared';
import type { HostPlatform } from '../../shared/os/hostEnv';

/**
 * A path as git prints it (`rev-parse --show-toplevel`, `worktree list --porcelain`), in the host's own spelling. git for
 * Windows prints forward slashes (`C:/Users/me/repo`); every other path of the host is written with backslashes, and the two
 * must compare equal. The line's terminator is dropped: CRLF or LF on win32 (a Windows process), only LF elsewhere (a trailing
 * CR is a legal last character of a POSIX name). POSIX output is otherwise already in the host's spelling. An empty output
 * stays empty rather than becoming `.`: it means git printed no path.
 */
export function normalizeGitPath(platform: HostPlatform, gitOutput: string): string {
  if (platform !== 'win32') return gitOutput.replace(/\n$/, '');
  const line = gitOutput.replace(/\r?\n$/, '');
  return line === '' ? '' : hostPathFor('win32').normalize(line);
}
