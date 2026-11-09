import { programFileName } from '../../../shared/os/shellCommands';

export const CLAUDE_LAUNCH_ENV = { CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false' } as const;

export function isClaudeProgram(program: string): boolean {
  return /^(?:claude|claude\.exe|claude\.cmd)$/i.test(programFileName(program));
}

/** Read a literal leading command without interpreting shell expansions or compound commands. */
export function isClaudeCommand(line: string): boolean {
  const match = /^\s*(?:'([^']*)'|"([^"$`\\]*)"|([^\s'"`$;&|<>()]+))(?=\s|$)/.exec(line);
  return match !== null && isClaudeProgram(match[1] ?? match[2] ?? match[3]);
}
