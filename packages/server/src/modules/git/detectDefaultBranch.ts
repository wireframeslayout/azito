import type { IServerTransport } from '../servers/transport/ServerTransport';
import { shellQuote } from '../../shared/shellQuote';

/**
 * Detects the repository's default branch from git state.
 * 1. `git symbolic-ref refs/remotes/origin/HEAD` — authoritative when set
 * 2. Check existence of both `main` and `master`:
 *    - exactly one exists -> use it
 *    - both exist / neither exists -> null (ambiguous or empty)
 *
 * Uses stdout/stderr content (not exit code) for SSH transport compatibility
 * (SSH transports always return exit code 0 — see `hasGitError()` in
 * RemoteWorktreeService for the same pattern).
 */
export async function detectDefaultBranch(
  transport: IServerTransport,
  workingDir: string,
): Promise<string | null> {
  // 1. Try origin/HEAD (set by git clone)
  const symRef = await transport.exec(
    `cd ${shellQuote(workingDir)} && git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null`,
    10_000,
  );
  const symRefOut = symRef.stdout?.trim();
  if (symRefOut && !symRefOut.includes('fatal:') && !symRefOut.includes('error:')) {
    // e.g. "refs/remotes/origin/main" -> "main"
    const match = symRefOut.match(/^refs\/remotes\/origin\/(.+)$/);
    if (match) return match[1];
  }

  // 2. Check main and master existence
  const [mainResult, masterResult] = await Promise.all([
    transport.exec(
      `cd ${shellQuote(workingDir)} && git rev-parse --verify --quiet refs/heads/main 2>/dev/null`,
      10_000,
    ),
    transport.exec(
      `cd ${shellQuote(workingDir)} && git rev-parse --verify --quiet refs/heads/master 2>/dev/null`,
      10_000,
    ),
  ]);

  const mainExists = isValidSha(mainResult.stdout);
  const masterExists = isValidSha(masterResult.stdout);

  if (mainExists && !masterExists) return 'main';
  if (masterExists && !mainExists) return 'master';
  // Both exist or neither exists -> ambiguous
  return null;
}

function isValidSha(stdout: string | undefined): boolean {
  const trimmed = stdout?.trim();
  return !!trimmed && /^[0-9a-f]{40}$/.test(trimmed);
}
