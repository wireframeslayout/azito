import { hostPathFor } from '@azito/shared';
import type { HostPlatform } from '../../shared/os/hostEnv';

/**
 * A path as git prints it (`rev-parse --show-toplevel`, `worktree list --porcelain`), in the host's own spelling. git for
 * Windows prints forward slashes (`C:/Users/me/repo`); every other path of the host is written with backslashes, and the two
 * must compare equal. POSIX output is already in the host's spelling and is returned as is. A trailing line break (`\r\n`
 * from a Windows process) is dropped.
 */
export function normalizeGitPath(platform: HostPlatform, gitOutput: string): string {
  const line = gitOutput.replace(/\r?\n$/, '');
  return platform === 'win32' ? hostPathFor('win32').normalize(line) : line;
}
