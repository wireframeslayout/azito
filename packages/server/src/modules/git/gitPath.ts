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

/** `.git` as the host's filesystem sees it: case-insensitive on win32 / darwin, and win32 ignores trailing dots and spaces. */
export function isGitDirectoryName(platform: HostPlatform, name: string): boolean {
  if (platform === 'linux') return name === '.git';
  const folded = name.toLowerCase();
  return (platform === 'win32' ? folded.replace(/[. ]+$/, '') : folded) === '.git';
}

const TASK_WORKTREE_NAME = /^task-(\d+)$/;
const WORKTREES_DIR_NAME = '.worktrees';

/** The task id of a path of the form `<repo>/.worktrees/task-<id>` in the host's spelling (`/` and `\\` alike on win32), or null. */
export function taskIdOfWorktreePath(platform: HostPlatform, worktreePath: string): number | null {
  const api = hostPathFor(platform);
  const normalized = api.normalize(normalizeGitPath(platform, worktreePath));
  const match = TASK_WORKTREE_NAME.exec(api.basename(normalized));
  if (!match) return null;
  const parentName = api.basename(api.dirname(normalized));
  const isWorktreesDir = platform === 'linux' ? parentName === WORKTREES_DIR_NAME : parentName.toLowerCase() === WORKTREES_DIR_NAME;
  return isWorktreesDir ? parseInt(match[1], 10) : null;
}
