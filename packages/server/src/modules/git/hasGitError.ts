import type { ExecResult } from '../servers/transport/ServerTransport';

/**
 * Detects a git failure from a remote `transport.exec()` result without
 * trusting `result.code`.
 *
 * `SshClient.execRemote()` (the `ssh` server type's transport) always
 * returns `code: 0` and `stderr: ''` — the marker-based exec protocol has no
 * way to propagate the remote shell's actual exit status, and every caller
 * in this codebase additionally redirects the remote command with `2>&1`,
 * which merges stderr into stdout before it ever reaches the transport. A
 * check like `result.code !== 0 || result.stderr.includes('fatal:')` is
 * therefore silently dead on `ssh` servers: `code` is always 0 and `stderr`
 * is always empty, so every remote git failure — a failed fetch, a failed
 * clone, a failed bundle verify — is reported as success. `local`/`agent`
 * transports do propagate a real exit code, so this only masks failures on
 * `ssh`, but the check must work uniformly across all three transport types
 * since callers don't know which one they're talking to.
 *
 * So this checks BOTH signals and ORs them together:
 *
 * - `result.code !== 0` — covers `local`/`agent` transports, where the exit
 *   code is real. This also catches failures that never print a `fatal:`/
 *   `error:` line at all (a shell-level permission error, a missing `git`
 *   executable, etc.) — detection that was lost when this function was
 *   extracted as a text-only scan (Issue #87 third-party review, fourth
 *   pass, Important finding 2). On `ssh`, `code` is always 0, so this half
 *   is always false there and never produces a false positive.
 * - a `fatal:`/`error:` line in the combined stdout+stderr text — the same
 *   approach `RemoteWorktreeService` already uses for worktree operations
 *   (extracted here so bundle/mirror operations use the identical, single
 *   implementation rather than a second copy that could drift). This is
 *   what actually detects failures on `ssh`, where `code` can't be trusted.
 *
 * Callers where a non-zero exit is an EXPECTED, non-error outcome (e.g.
 * `git rev-parse --verify <ref>` used purely to test whether `<ref>`
 * exists) must not route that "expected no" result through this function
 * at all — model the check as its own boolean, not as an error.
 */
export function hasGitError(result: ExecResult): boolean {
  const combined = `${result.stdout}\n${result.stderr}`.trim();
  return result.code !== 0 || /^fatal:|^error:/m.test(combined);
}
