/** An agent session id as the hub records it on a window row: a UUID (Claude Code's `--session-id` / `--resume`). */
export const AGENT_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAgentSessionId(value: string): boolean {
  return AGENT_SESSION_ID_PATTERN.test(value);
}
