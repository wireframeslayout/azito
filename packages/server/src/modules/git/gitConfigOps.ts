import { runGit, combinedOutput } from './runGit';
import type { GitTransport } from './gitPath';

const GIT_CONFIG_KEY_UNSET_EXIT_CODE = 1;
const GIT_CONFIG_TIMEOUT_MS = 10_000;

/**
 * The value of a git config key in `worktreePath`, or '' when the key is unset (git config exits 1 with nothing on stderr).
 * The same call for a local server and an agent: git is run without a shell on the host that owns the repository, and its
 * exit code is real.
 */
export async function getGitConfigValue(transport: GitTransport, worktreePath: string, key: string): Promise<string> {
  const result = await runGit(transport, undefined, ['-C', worktreePath, 'config', key], { timeoutMs: GIT_CONFIG_TIMEOUT_MS });
  if (result.exitCode === 0) return result.stdout.trim();
  if (result.exitCode === GIT_CONFIG_KEY_UNSET_EXIT_CODE && result.stderr.trim() === '') return '';
  throw new Error(`git config ${key} read failed: ${combinedOutput(result) || `exit ${result.exitCode}`}`);
}

export async function setGitConfigValue(transport: GitTransport, worktreePath: string, key: string, value: string): Promise<void> {
  const result = await runGit(transport, undefined, ['-C', worktreePath, 'config', key, value], { timeoutMs: GIT_CONFIG_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    throw new Error(`git config ${key} failed: ${combinedOutput(result) || `exit ${result.exitCode}`}`);
  }
}
