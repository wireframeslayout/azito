/**
 * MCP blocking policy (Issue #471): determine whether a window's agent
 * launch should include MCP blocking flags (`--strict-mcp-config` for
 * claude, `-c mcp_servers.azt-mcp.enabled=false` for codex).
 *
 * Blocking is mandatory for task worker panes (`isPrimary`) but
 * optional for user-added windows (`isPrimary === false`).  When a
 * non-primary window is attached to a task whose execution is gated
 * (untrusted input, locked policy), blocking is still applied.
 *
 * The function is **fail-closed**: ambiguous inputs (`isPrimary`
 * undefined, task lookup failure) result in blocking.
 */

import { CODEX_MCP_DISABLE_TEXTS } from './codex/launchCommand';

// ─── Types ───

interface ShouldBlockMcpInput {
  /** `true` = worker pane, `false` = user-added, `undefined` = unknown */
  isPrimary: boolean | undefined;
  /** `null` = no task linked, `'unknown'` = lookup failed */
  linkedTask: { executionAllowed: boolean } | null | 'unknown';
}

// ─── Pure decision function ───

export function shouldBlockMcp({ isPrimary, linkedTask }: ShouldBlockMcpInput): boolean {
  // Unknown window type → fail-closed
  if (isPrimary === undefined) return true;

  // Worker pane → always block
  if (isPrimary) return true;

  // User-added window, no task → no block
  if (linkedTask === null) return false;

  // Task lookup failed → fail-closed
  if (linkedTask === 'unknown') return true;

  // Task present, execution allowed → no block
  if (linkedTask.executionAllowed) return false;

  // Task present, execution not allowed → block
  return true;
}

// ─── Command-level flag helpers ───

const STRICT_MCP_CONFIG_TOKEN = '--strict-mcp-config';
const CODEX_MCP_DISABLE_TOKENS = CODEX_MCP_DISABLE_TEXTS.map((text) => `-c ${text}`);

/** Ensure the claude `--strict-mcp-config` flag is present in `command`. */
export function ensureClaudeMcpBlock(command: string): string {
  if (command.includes(STRICT_MCP_CONFIG_TOKEN)) return command;
  return `${command} ${STRICT_MCP_CONFIG_TOKEN}`;
}

/** Ensure every codex azt-mcp disabling `-c` override (see CODEX_MCP_DISABLE_TEXTS) is present in `command`. */
export function ensureCodexMcpBlock(command: string): string {
  return CODEX_MCP_DISABLE_TOKENS.reduce((acc, token) => (acc.includes(token) ? acc : `${acc} ${token}`), command);
}

/**
 * Detect the CLI tool from the command's leading word and apply the
 * corresponding MCP blocking flag.  Falls back to no-op when the
 * command is not recognised (generic / unknown worker types).
 */
export function ensureMcpBlockByCommand(command: string): string {
  if (/^claude\b/.test(command)) return ensureClaudeMcpBlock(command);
  if (/^codex\b/.test(command)) return ensureCodexMcpBlock(command);
  return command;
}
