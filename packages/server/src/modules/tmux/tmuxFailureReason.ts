/** A known tmux failure class read from process output, or null. Never returns the output itself. */
function classifyTmuxOutput(output: string): string | null {
  if (/timed out/i.test(output)) return 'timed out';
  if (/command not found/i.test(output)) return 'command not found';
  if (/permission denied/i.test(output)) return 'permission denied';
  if (/ECONNREFUSED|connection refused/i.test(output)) return 'connection refused';
  if (/no server running/i.test(output) || /error connecting to .*\(no such file or directory\)/i.test(output)) return 'no server running on tmux socket';
  if (/can't find/i.test(output)) return "can't find target";
  if (/no such session/i.test(output)) return 'no such session';
  if (/duplicate session/i.test(output)) return 'duplicate session';
  if (/not found|no such|does not exist/i.test(output)) return 'target not found';
  return null;
}

/** Preserve known tmux classifications without exposing process output or arguments. */
export function tmuxFailureReason(output: string, code: number): string {
  return classifyTmuxOutput(output) ?? `exit ${code}`;
}

/**
 * The same classification for a thrown tmux failure (a spawn error, a timeout, or an already sanitized error):
 * `output` is the process's stderr when the caller has it, otherwise the error's own stderr and message are read.
 */
export function tmuxErrorReason(err: unknown, output?: string): string {
  const source = (typeof err === 'object' && err !== null ? err : {}) as { code?: unknown; killed?: unknown; message?: unknown; stderr?: unknown };
  if (source.code === 'ENOENT') return 'binary not found';
  if (source.killed === true) return 'timed out';
  const text = output ?? [source.stderr, source.message].filter((part): part is string => typeof part === 'string').join('\n');
  const known = classifyTmuxOutput(text);
  if (known) return known;
  return typeof source.code === 'number' ? `exit ${source.code}` : 'execution failed';
}

/** An Error that carries only the operation, the class of the failure and the fields callers classify by. */
export function sanitizedTmuxError(operation: string | undefined, err: unknown, output?: string): Error & { code?: unknown; killed?: boolean } {
  const source = (typeof err === 'object' && err !== null ? err : {}) as { code?: unknown; killed?: unknown };
  const safe = new Error(`tmux ${operation} failed: ${tmuxErrorReason(err, output)}`) as Error & { code?: unknown; killed?: boolean };
  safe.code = source.code;
  if (source.killed === true) safe.killed = true;
  return safe;
}
