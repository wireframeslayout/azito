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
 * Instead, this scans the combined stdout+stderr text for a `fatal:` or
 * `error:` line that git itself writes to signal failure — the same
 * approach `RemoteWorktreeService` already uses for worktree operations
 * (extracted here so bundle/mirror operations use the identical, single
 * implementation rather than a second copy that could drift).
 */
export function hasGitError(result: ExecResult): boolean {
  const combined = `${result.stdout}\n${result.stderr}`.trim();
  return /^fatal:|^error:/m.test(combined);
}
