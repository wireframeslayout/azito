import type { ExecResult, IServerTransport } from '../servers/transport/ServerTransport';

/**
 * Exit-status sentinel for remote git commands (Issue #87 third-party
 * review, seventh pass, Important finding 1).
 *
 * `hasGitError()`'s doc comment explains why `result.code`/`result.stderr`
 * can't be trusted on `ssh` transports: `SshClient.execRemote()` always
 * returns `code: 0`/`stderr: ''`, so the only way to detect a failure there
 * used to be scanning combined stdout+stderr text for a `fatal:`/`error:`
 * line. That text scan misses any failure that doesn't happen to print in
 * git's own message format — e.g. `sh: git: command not found` or
 * `Permission denied` from the remote shell itself, neither of which starts
 * with `fatal:`/`error:`. On `ssh` transports those failures were silently
 * reported as success.
 *
 * This module fixes that at the source instead of extending the text scan:
 * every command run through {@link execWithSentinel} has
 * `; echo "AZITO_RC:$?"` appended on the remote shell, so the REMOTE shell's
 * own exit status is captured as literal text in stdout — a signal that
 * survives the `ssh` transport's `code`/`stderr` loss unchanged, because it
 * travels as ordinary command output rather than as transport-level exit
 * status. Judgment then follows a strict priority:
 *
 * 1. The sentinel line IS present — the reported exit code decides success
 *    or failure, regardless of what the rest of the output says. No text
 *    scanning of any kind.
 * 2. The sentinel line is ABSENT — the remote command never ran to
 *    completion (connection drop, command timeout, the transport itself
 *    failing). This is treated as a failure distinct from an ordinary git
 *    rejection: {@link RemoteGitCommandError.transportFailure} is `true`, so
 *    callers (`FetchDistributionService`'s incremental->full bundle
 *    fallback) can tell "the transfer/execution layer broke" apart from
 *    "git ran and rejected the content" without any string matching.
 *
 * This module is deliberately separate from `hasGitError()`, which
 * `RemoteWorktreeService` still uses unchanged (out of scope here) — the
 * two solve the same underlying transport problem with different
 * mechanisms and are not meant to be merged.
 */

const SENTINEL_PREFIX = 'AZITO_RC:';
const SENTINEL_LINE_RE = new RegExp(`^${SENTINEL_PREFIX}(-?\\d+)\\s*$`, 'm');

export interface SentinelExecOutcome {
  /** `true` only when the sentinel was observed AND its exit code was 0. */
  ok: boolean;
  /** `false` means the command never completed inside the transport — a
   * transfer/execution-layer anomaly, not a git-level rejection. */
  sentinelFound: boolean;
  /** The remote shell's real exit status, or `null` when the sentinel was
   * never observed. */
  exitCode: number | null;
  /** Combined command output with the trailing sentinel line stripped. */
  stdout: string;
  stderr: string;
}

/**
 * Thrown by {@link execGitOrThrow} on failure. `transportFailure` is the
 * signal callers use to decide whether retrying with different bundle
 * content could possibly help (`false` — git actually ran and rejected it)
 * or definitely can't (`true` — the command never completed at all).
 */
export class RemoteGitCommandError extends Error {
  readonly transportFailure: boolean;

  constructor(message: string, options: { transportFailure: boolean; cause?: unknown }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'RemoteGitCommandError';
    this.transportFailure = options.transportFailure;
  }
}

function appendSentinel(command: string): string {
  return `${command}; echo "${SENTINEL_PREFIX}$?"`;
}

function parseSentinel(result: ExecResult): SentinelExecOutcome {
  const match = SENTINEL_LINE_RE.exec(result.stdout);
  if (!match) {
    return { ok: false, sentinelFound: false, exitCode: null, stdout: result.stdout, stderr: result.stderr };
  }
  const exitCode = Number(match[1]);
  const stdout = (result.stdout.slice(0, match.index) + result.stdout.slice(match.index + match[0].length)).trim();
  return { ok: exitCode === 0, sentinelFound: true, exitCode, stdout, stderr: result.stderr };
}

/** Runs `command` with the exit-status sentinel appended and parses the result. */
export async function execWithSentinel(
  transport: IServerTransport,
  command: string,
  timeoutMs?: number,
): Promise<SentinelExecOutcome> {
  const result = await transport.exec(appendSentinel(command), timeoutMs);
  return parseSentinel(result);
}

/**
 * Convenience wrapper for the common "throw on anything but a clean exit"
 * call shape used throughout `RemoteBundleOps`.
 */
export async function execGitOrThrow(
  transport: IServerTransport,
  command: string,
  timeoutMs: number,
  failureMessage: string,
): Promise<SentinelExecOutcome> {
  const outcome = await execWithSentinel(transport, command, timeoutMs);
  if (outcome.ok) return outcome;
  throw new RemoteGitCommandError(
    outcome.sentinelFound
      ? `${failureMessage}: ${outcome.stdout || outcome.stderr}`
      : `${failureMessage}: command did not complete (transport/execution failure)`,
    { transportFailure: !outcome.sentinelFound },
  );
}
