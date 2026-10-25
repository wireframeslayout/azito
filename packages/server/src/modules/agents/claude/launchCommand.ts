import { shellQuote } from '../../../shared/shellQuote';
import type { LaunchOptions } from '../AgentProvider';
import { extraArgValues, flag, value, type ProgramLaunch } from '../WorkerLaunch';

/**
 * `--strict-mcp-config` (Issue #28 design v3 §3): a task worker's tmux pane
 * inherits the operator's `~/.claude/settings.json`, whose `azt-mcp` MCP
 * server config carries the operator's full-power `AZITO_UI_TOKEN` (see
 * harness/skills/azt-mcp) — without this flag, an untrusted-input task could
 * reach that MCP server and, through it, the UI-token-authenticated API
 * surface. Measured (not assumed): task workers never actually use MCP
 * tools, only the operator's own interactive Claude Code session does, so
 * this is safe to add unconditionally, not gated behind AZITO_SCOPED_AUTH —
 * see AGENTS.md's Issue #28 Phase A scope note. Deliberately claude-only:
 * `--strict-mcp-config` is a claude-cli-specific flag, and adding it to
 * codex/generic worker launches would just be an unrecognized argument.
 */
const STRICT_MCP_CONFIG_FLAG = '--strict-mcp-config';

/** `claude` started fresh, or resumed when `agentSessionId` is given (`claude --resume <id> ...`; a new session's id is added by the caller). */
export function buildClaudeLaunch({ model, extraArgs, blockMcp = true }: LaunchOptions, agentSessionId: string | null = null): ProgramLaunch {
  return {
    kind: 'program',
    file: 'claude',
    args: [
      ...(agentSessionId ? [flag('--resume'), flag(agentSessionId)] : []),
      flag('--dangerously-skip-permissions'),
      ...(blockMcp ? [flag(STRICT_MCP_CONFIG_FLAG)] : []),
      ...(model ? [flag('--model'), value(model)] : []),
      ...extraArgValues(extraArgs),
    ],
  };
}

export function buildClaudeHeadlessCommand(model: string): string {
  const modelFlag = ` --model ${shellQuote(model)}`;
  return `claude -p${modelFlag}`;
}
