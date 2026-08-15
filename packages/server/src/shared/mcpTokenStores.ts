// ─── azt-mcp credential-store discovery (Claude settings.json / Codex config.toml) ───
//
// Shared by `azito auth doctor` (packages/server/src/cli/authDoctorCommand.ts,
// reads local files via `fs`) and the isolation doctor
// (packages/server/src/modules/servers/isolationDoctor.ts, reads the SAME two
// files on a remote `agent` server via `IServerTransport.exec` + `cat`) — both
// need the exact same "does this azt-mcp registration still carry a live
// AZITO_UI_TOKEN" predicate `harness/setup.sh --purge-operator-token` uses to
// decide what to clean up, so the judgment logic lives in one place instead of
// two independently-drifting copies.

export interface McpSettingsFile {
  mcpServers?: Record<string, { env?: Record<string, string> }>;
}

export type McpUiTokenExtraction =
  | { status: 'absent' }
  | { status: 'unreadable'; error: string }
  | { status: 'present'; token: string };

/**
 * Pure JSON-parsing predicate for Claude's `~/.claude/settings.json` —
 * "does the `mcpServers.azt-mcp.env` block carry a live `AZITO_UI_TOKEN`".
 * Parse failure (not valid JSON) is reported as `'unreadable'`, distinct from
 * `'absent'` (valid JSON, just no token there) — callers must not fold the
 * two together (see authDoctorCommand.ts's own doc comment on this
 * distinction, and isolationDoctor.ts's fail-closed contract: `'unreadable'`
 * must become `'unknown'`, never `'pass'`).
 */
export function extractClaudeMcpUiToken(content: string, mcpKey = 'azt-mcp'): McpUiTokenExtraction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return { status: 'unreadable', error: err instanceof Error ? err.message : String(err) };
  }
  // Review finding (isolation doctor round): `JSON.parse` accepts any valid
  // JSON document, not just objects — `null`, an array, or a bare scalar
  // (`"42"`, `true`) all parse without throwing. The old code went straight
  // to `settings.mcpServers?.[mcpKey]?.env?.AZITO_UI_TOKEN` on the parsed
  // value, which is safe for `null`/scalars (optional chaining short-circuits)
  // but throws a TypeError for an array whose first element the accessor
  // chain doesn't reach — Claude's settings.json is attacker-adjacent content
  // read from a remote agent server, so a malformed-but-valid-JSON file must
  // report `'unreadable'` (fail-closed, same as a parse error), never crash
  // the doctor route or `azito auth doctor`.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'unreadable', error: 'settings.json is not a JSON object' };
  }
  const settings = parsed as McpSettingsFile;
  const token = settings.mcpServers?.[mcpKey]?.env?.AZITO_UI_TOKEN;
  return token ? { status: 'present', token } : { status: 'absent' };
}

/**
 * Conservative bare-substring scan for a live `AZITO_UI_TOKEN` in Codex's
 * `config.toml`, mirroring `harness/setup.sh`'s own `strip_codex_ui_token()`
 * final safety-net check (see that function's comment in setup.sh): `codex
 * mcp add` can legally emit the token under several different TOML shapes
 * (unquoted/quoted table headers, an `env` sub-table, or an inline table on
 * the `[mcp_servers.azt-mcp]` entry itself), and a full TOML parser here
 * would have to special-case every one of them to stay in sync with whatever
 * shape a given codex-cli version happens to write. This codebase has no
 * other reason to ever write the literal string "AZITO_UI_TOKEN" into
 * config.toml, so treating ANY occurrence as evidence of a live token is
 * deliberately over-inclusive rather than risking a shape this scan misses.
 */
export function hasCodexConfigUiToken(content: string): boolean {
  return content.includes('AZITO_UI_TOKEN');
}
