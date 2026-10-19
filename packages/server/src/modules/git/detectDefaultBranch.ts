import type { IServerTransport } from '../servers/transport/ServerTransport';
import { runGit } from './runGit';

const GIT_TIMEOUT_MS = 10_000;

/**
 * Detects the repository's default branch from git state.
 * 1. `git symbolic-ref refs/remotes/origin/HEAD` — authoritative when set
 * 2. Check existence of both `main` and `master`:
 *    - exactly one exists -> use it
 *    - both exist / neither exists -> null (ambiguous or empty)
 *
 * Each git command's real exit code decides whether its answer counts: a non-zero exit (no origin/HEAD, no such
 * branch, not a repository) is "no answer", and the next step is tried.
 */
export async function detectDefaultBranch(
  transport: Pick<IServerTransport, 'run'>,
  workingDir: string,
): Promise<string | null> {
  // 1. Try origin/HEAD (set by git clone)
  const symRef = await runGit(transport, workingDir, ['symbolic-ref', 'refs/remotes/origin/HEAD'], { timeoutMs: GIT_TIMEOUT_MS });
  if (symRef.exitCode === 0) {
    // e.g. "refs/remotes/origin/main" -> "main"
    const match = symRef.stdout.trim().match(/^refs\/remotes\/origin\/(.+)$/);
    if (match) return match[1];
  }

  // 2. Check main and master existence
  const [mainResult, masterResult] = await Promise.all([
    runGit(transport, workingDir, ['rev-parse', '--verify', '--quiet', 'refs/heads/main'], { timeoutMs: GIT_TIMEOUT_MS }),
    runGit(transport, workingDir, ['rev-parse', '--verify', '--quiet', 'refs/heads/master'], { timeoutMs: GIT_TIMEOUT_MS }),
  ]);

  const mainExists = mainResult.exitCode === 0 && isValidSha(mainResult.stdout);
  const masterExists = masterResult.exitCode === 0 && isValidSha(masterResult.stdout);

  if (mainExists && !masterExists) return 'main';
  if (masterExists && !mainExists) return 'master';
  // Both exist or neither exists -> ambiguous
  return null;
}

function isValidSha(stdout: string): boolean {
  return /^[0-9a-f]{40}$/.test(stdout.trim());
}
