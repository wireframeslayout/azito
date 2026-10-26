import { shellQuote } from '../../../shared/shellQuote';
import type { LaunchOptions } from '../AgentProvider';
import { extraArgValues, flag, value, type LaunchArg, type ProgramLaunch } from '../WorkerLaunch';

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
export const CODEX_MCP_DISABLE_TEXTS = [
  'mcp_servers.azt-mcp.enabled=false',
  // Issue #522: `-c` deep-merges into the host's config.toml. On a host that never registered azt-mcp (a fresh host, a harness
  // installed without a UI token, a Windows agent) `enabled=false` alone builds an entry with no transport and codex refuses to
  // load its config ("invalid transport in mcp_servers.azt-mcp"; reproduced on codex-cli 0.149.1 and 0.163.0). A `command` makes
  // that entry a valid stdio definition, and since it is disabled it is never started. The value is deliberately an unquoted
  // word: codex's `-c` parser (codex-rs/utils/cli/src/config_override.rs, identical in rust-v0.149.0 / v0.163.0 / v0.164.0) tries
  // TOML first and, when that fails, takes the text as a string — so no `"` has to survive the shell (POSIX) or cmd.exe, whose
  // special characters `launchArgv` refuses. A bare word that is valid TOML (`true`, `1`) would become a non-string and fail.
  // A host whose azt-mcp is stdio (what setup.sh / setup.mjs register) keeps working: only its command is replaced, and it is disabled.
  // A host whose azt-mcp is a `url` (streamable_http) transport fails to load ("url is not supported for stdio",
  // codex-rs/config/src/mcp_types.rs) — fail-closed, never an azt-mcp usable by the worker. We do not register that form.
  'mcp_servers.azt-mcp.command=azt-mcp-disabled',
] as const;

const CODEX_MCP_DISABLE_ARGS: readonly LaunchArg[] = CODEX_MCP_DISABLE_TEXTS.flatMap((text) => [flag('-c'), flag(text)]);

/**
 * Shared base builder for both a fresh `codex` launch and a `codex resume
 * <id>` relaunch (Issue #28 third-party review, respawn-MCP-bypass fix):
 * the two previously diverged (the respawn builder in SessionStrategy.ts
 * hand-rolled its own resume string), and the resume path silently missed
 * `CODEX_MCP_DISABLE_ARGS` — a respawned codex worker pane could load the
 * operator's azt-mcp (full-power AZITO_UI_TOKEN) and bypass task-token
 * scoping. Both paths now go through this one function so the flag can't
 * drift out of sync again.
 */
function buildCodexProgram(agentSessionId: string | null, { model, extraArgs, blockMcp = true }: LaunchOptions): ProgramLaunch {
  return {
    kind: 'program',
    file: 'codex',
    args: [
      ...(agentSessionId ? [flag('resume'), flag(agentSessionId)] : []),
      flag('--dangerously-bypass-approvals-and-sandbox'),
      ...(blockMcp ? CODEX_MCP_DISABLE_ARGS : []),
      ...(model ? [flag('--model'), value(model)] : []),
      ...extraArgValues(extraArgs),
    ],
  };
}

export function buildCodexLaunch(opts: LaunchOptions): ProgramLaunch {
  return buildCodexProgram(null, opts);
}

export function buildCodexRespawnLaunch(agentSessionId: string, opts: LaunchOptions): ProgramLaunch {
  return buildCodexProgram(agentSessionId, opts);
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
