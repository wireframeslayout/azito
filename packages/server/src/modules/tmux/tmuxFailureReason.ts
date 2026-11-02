/** Preserve known tmux classifications without exposing process output or arguments. */
export function tmuxFailureReason(output: string, code: number): string {
  if (/command not found/i.test(output)) return 'command not found';
  if (/no server running/i.test(output) || /error connecting to .*\(no such file or directory\)/i.test(output)) return 'no server running on tmux socket';
  if (/can't find/i.test(output)) return "can't find target";
  if (/no such session/i.test(output)) return 'no such session';
  if (/duplicate session/i.test(output)) return 'duplicate session';
  if (/not found|no such|does not exist/i.test(output)) return 'target not found';
  return `exit ${code}`;
}
