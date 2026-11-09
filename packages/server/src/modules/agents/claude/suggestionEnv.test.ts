import { describe, expect, it } from 'vitest';
import { isClaudeCommand, isClaudeProgram } from './suggestionEnv';

describe('Claude executable detection', () => {
  it.each(['claude', '/usr/local/bin/claude', 'C:\\tools\\claude.cmd', 'C:\\tools\\claude.exe'])(
    'recognises %s', (command) => { expect(isClaudeProgram(command)).toBe(true); },
  );
  it.each(['codex', 'my-claude', '/usr/bin/claude-helper'])(
    'does not recognise %s', (command) => { expect(isClaudeProgram(command)).toBe(false); },
  );
  it.each(['claude --model opus', '/usr/bin/claude --version', "'/opt/claude code/claude' --version", '"/opt/claude code/claude" --version'])(
    'recognises the literal leading command %s', (command) => { expect(isClaudeCommand(command)).toBe(true); },
  );
  it.each(['codex --model claude', 'tool claude', '$RUNNER --flag', 'claude-helper'])(
    'does not infer Claude from %s', (command) => { expect(isClaudeCommand(command)).toBe(false); },
  );
});
