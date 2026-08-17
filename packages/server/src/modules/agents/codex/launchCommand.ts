import { shellQuote } from '../../../shared/shellQuote';
import type { LaunchOptions } from '../AgentProvider';

/**
 * Third-party review (Issue #28 fix 2): a codex worker's tmux pane inherits
 * the operator's `~/.codex/config.toml`, whose `azt-mcp` MCP server (added by
 * `harness/setup.sh` around line 460) carries the operator's full-power
 * `AZITO_UI_TOKEN` — a task could reach it and bypass task-token scoping the
 * same way `--strict-mcp-config` (see claude/launchCommand.ts) closes off for
 * claude. codex has no interactive-mode equivalent of claude's
 * `--strict-mcp-config` or `codex exec`'s `--ignore-user-config` (verified via
 * `codex --help` on codex-cli 0.146.0 — `--ignore-user-config` is listed only
 * under `codex exec --help`, not top-level `codex --help`, and there is no
 * flag to disable MCP servers generically by not-yet-known name). The
 * `-c key=value` config override IS available at the top level and DOES take
 * effect for MCP server enablement — verified with
 * `codex doctor --json -c 'mcp_servers.azt-mcp.enabled=false'`, which flips
 * `mcp.config.details["disabled servers"]` from absent/0 to `"1"` (vs. an
 * unscoped `-c mcp_servers={}` override, which does NOT clear the table —
 * `-c` deep-merges into existing keys, it does not replace whole maps). This
 * targets the specific server this codebase's own `setup.sh` registers by
 * name; it does not protect against some other MCP server an operator
 * registered by hand under a different name (out of scope here — the review
 * finding is specifically about our own azt-mcp carrying the UI token).
 */
const CODEX_MCP_DISABLE_FLAG = ` -c mcp_servers.azt-mcp.enabled=false`;

/**
 * Shared base builder for both a fresh `codex` launch and a `codex resume
 * <id>` relaunch (Issue #28 third-party review, respawn-MCP-bypass fix):
 * the two previously diverged (buildRespawnCommand in SessionStrategy.ts
 * hand-rolled its own resume string), and the resume path silently missed
 * `CODEX_MCP_DISABLE_FLAG` — a respawned codex worker pane could load the
 * operator's azt-mcp (full-power AZITO_UI_TOKEN) and bypass task-token
 * scoping. Both paths now go through this one function so the flag can't
 * drift out of sync again.
 */
function buildCodexCommand(agentSessionId: string | null, { model, extraArgs }: LaunchOptions): string {
  const resumePrefix = agentSessionId ? `resume ${agentSessionId} ` : '';
  const modelFlag = model ? ` --model ${shellQuote(model)}` : '';
  const extra = extraArgs?.trim()
    ? ' ' + extraArgs.trim().split(/\s+/).map(shellQuote).join(' ')
    : '';
  return `codex ${resumePrefix}--dangerously-bypass-approvals-and-sandbox${CODEX_MCP_DISABLE_FLAG}${modelFlag}${extra}`;
}

export function buildCodexLaunchCommand(opts: LaunchOptions): string {
  return buildCodexCommand(null, opts);
}

export function buildCodexRespawnCommand(agentSessionId: string, opts: LaunchOptions): string {
  return buildCodexCommand(agentSessionId, opts);
}

/**
 * `codex exec` (used for headless subagent delegation) DOES support
 * `--ignore-user-config` ("Do not load $CODEX_HOME/config.toml; auth still
 * uses CODEX_HOME" per `codex exec --help`) — the same flag
 * `CodexExecClient.ts` already relies on for the hub's own internal codex
 * calls. Prefer it here over the named-server override above: it blocks the
 * operator's entire config.toml (any MCP server, not just azt-mcp by name).
 */
export function buildCodexHeadlessCommand(model: string): string {
  const modelFlag = ` --model ${shellQuote(model)}`;
  return `codex exec --ignore-user-config${modelFlag}`;
}
