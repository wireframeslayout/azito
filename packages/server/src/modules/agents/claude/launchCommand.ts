import { shellQuote } from '../../../shared/shellQuote';
import type { LaunchOptions } from '../AgentProvider';

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
const STRICT_MCP_CONFIG_FLAG = ' --strict-mcp-config';

export function buildClaudeLaunchCommand({ model, extraArgs, blockMcp = true, dialect }: LaunchOptions): string {
  const mcpFlag = blockMcp ? STRICT_MCP_CONFIG_FLAG : '';
  const modelFlag = model ? ` --model ${dialect.quote(model)}` : '';
  const extra = extraArgs?.trim()
    ? ' ' + extraArgs.trim().split(/\s+/).map((arg) => dialect.quote(arg)).join(' ')
    : '';
  return `claude --dangerously-skip-permissions${mcpFlag}${modelFlag}${extra}`;
}

export function buildClaudeHeadlessCommand(model: string): string {
  const modelFlag = ` --model ${shellQuote(model)}`;
  return `claude -p${modelFlag}`;
}
